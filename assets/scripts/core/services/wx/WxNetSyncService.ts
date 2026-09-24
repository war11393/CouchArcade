/**
 * Wx 网络同步服务 —— 第二阶段真实实现。
 *
 * 实时通道选型：采用「云数据库 watch（实时数据推送）」，
 * 备选方案「云托管 WebSocket」的对比与结论见 docs/REALTIME_CHANNEL_DECISION.md。
 *
 * 架构（服务端权威）：
 *   上行 send(cmd, payload) → 云函数（planehunt_flip / gomoku_move）做合法性校验并落库
 *   下行 watch 对局集合     → onChange 把新增/变更的棋步转成 NetMessage 回调业务层
 *
 * 为什么上行必须走云函数而不是客户端直写数据库：
 *   客户端直写无法防作弊 —— 改前端即可伪造棋步。云函数内校验是无外挂的基础保障。
 *
 * 本类与 MockNetSyncService 的方法签名、消息信封结构完全一致，
 * 切换后业务层（各游戏的 onSyncMessage）无需任何改动。
 */

import { COLLECTIONS } from '../../../config/Collections';
import { ERR } from '../../../config/CloudErrors';
import { GameId } from '../../../config/GameList';
import { Cmd, makeEnvelope } from '../../protocol/Protocol';
import { INetSyncService, NetMessage, NetMessageHandler, NetStatus } from '../IServices';

/**
 * 上行被服务端受理后，等待 watch 下行的超时（毫秒）。
 *
 * 取值理由：正常路径下 watch 推送在 100~500ms 内到达；4s 足够覆盖慢网与
 * 服务端首次冷启动，又不至于让玩家在真机上干等太久才看到诊断信息。
 * 超时**不改变**任何业务行为（只打日志）—— 免得把「网络慢」误伤成「落子失败」。
 */
const WATCH_ACK_TIMEOUT_MS = 4000;

/** 对局文档（games_gomoku / games_planehunt）在客户端侧的可见字段。 */
interface GameDoc {
    roomId: string;
    /** 五子棋：棋盘二维数组；寻机头：客户端不应使用该字段（见下）。 */
    board?: number[][];
    /** 寻机头：**绝不下发客户端**的权威布局（防御性声明，不读取）。 */
    cells?: unknown;
    moveCount?: number;
    flips?: unknown[];
    finished?: boolean;
    currentPlayerId?: string;
    lastMove?: {
        row: number;
        col: number;
        stone: number;
        playerId: string;
        /**
         * 这一手之后轮到谁。
         *
         * ⚠️ 必须由云函数写进 lastMove —— 文档上的 `currentPlayerId` 虽然在
         *    startGame / gomoku_move 里都写过，但 **startGame 的返回没有落库**，
         *    历史实现里它可能是缺失的；没有它客户端算不出回合，
         *    `isMyTurn()` 恒 false，表现为「点棋盘没有任何反应」。
         */
        nextPlayerId?: string;
        /** 这一手是否终结了整局（客户端据此结束本地推演）。 */
        finished?: boolean;
    };
    lastFlip?: Record<string, unknown>;
    winnerId?: string;
    [key: string]: unknown;
}

export class WxNetSyncService implements INetSyncService {
    private readonly _msgHandlers: NetMessageHandler[] = [];
    private readonly _statusHandlers: Array<(s: NetStatus) => void> = [];

    private _status: NetStatus = NetStatus.DISCONNECTED;
    private _roomId = '';
    private _playerId = '';
    private _gameId: GameId | null = null;

    /** 对局集合的 watch 取消函数。 */
    private _unwatch: (() => void) | null = null;
    /** 上次已处理的 moveCount / flips 长度，用于增量 diff（避免重复派发）。 */
    private _lastMoveCount = 0;
    private _lastFlipCount = 0;
    /** 对局是否已派发过结束消息（防重复结算）。 */
    private _gameOverDispatched = false;

    /**
     * watch 下行计数与看门狗句柄集合。
     *
     * 语义：`_watchAckCount` 在收到任何一条对局 watch 下行时 +1；
     * 每次发上行请求前记下基线，`WATCH_ACK_TIMEOUT_MS` 后比对 ——
     * 计数没超过基线 = 请求发出后一条下行都没到过（下行通道断）。
     * `_watchdogs` 收集所有在途定时器，disconnect 时统一清理，
     * 避免对局结束/切场景之后残留一条吓人的误报。
     */
    private _watchAckCount = 0;
    private readonly _watchdogs = new Set<ReturnType<typeof setTimeout>>();

    // ==================== 对外接口实现 ====================

    /**
     * 连接指定房间的同步通道。
     *
     * 注意：调用前需先设置 gameId（见 setGameId），以确定监听哪个对局集合；
     * 取不到 gameId 时回落到监听 rooms 集合（至少能感知开局/解散）。
     */
    public async connect(roomId: string): Promise<void> {
        this._roomId = roomId;
        this._setStatus(NetStatus.CONNECTING);
        console.log(`[WxNetSync] 正在连接房间 ${roomId} gameId=${this._gameId ?? '未指定'} ...`);

        // 显式释放旧连接（防止 watch 连接数累积超过 5 个上限）
        this._closeWatch();

        this._openWatch();

        // ⚠️ 必须显式置 CONNECTED —— 这是「点了棋盘没有落子」的直接原因。
        //
        // send() 的第一道闸是 `if (this._status !== NetStatus.CONNECTED) return;`
        // 而本函数原先只置了 CONNECTING、然后直接打「已连接」日志就返回了，
        // 于是**永远停在 CONNECTING**：每一次落子/翻牌请求都被静默丢弃，
        // 控制台只留下一行「未连接，忽略发送: gk.move」，
        // 界面则卡在「对手思考中…」（因为 showThinking(true) 之后再也等不到下行）。
        //
        // 为什么能安全地立即置 CONNECTED：`_watchCollection` 是**同步**建立的
        // （wx 的 watch 采用回调式，onChange 到达即代表通道可用），
        // 不涉及 await 握手。真正的连接异常由 watch 的 onError 回调
        // 置 RECONNECTING 兜底（见 _watchCollection）。
        //
        // 对照参考实现：MockNetSyncService.connect 在握手后同样会置 CONNECTED，
        // 并且还会 flush 权威方的首手消息（见下方）。
        this._setStatus(NetStatus.CONNECTED);
        console.log(`[WxNetSync] 已连接房间 ${roomId}（云数据库实时推送）`);
    }

    /**
     * 发送上行消息。
     *
     * 映射到云函数（服务端权威校验）：
     *   ph.flip      → planehunt_flip   { roomId, row, col }
     *   gk.move      → gomoku_move      { roomId, row, col }
     *   game.surrender → settleGame     { roomId, result: { winnerId: '' } }（判负）
     *   其它 cmd     → 忽略并告警（下行消息不应由客户端发起）
     */
    public send(cmd: string, payload: unknown): void {
        if (this._status !== NetStatus.CONNECTED) {
            console.warn(`[WxNetSync] 未连接，忽略发送: ${cmd}`);
            return;
        }

        const data = (payload ?? {}) as Record<string, unknown>;
        const reqSeqRaw = data.reqSeq;
        const reqSeq = typeof reqSeqRaw === 'number' ? reqSeqRaw : undefined;

        switch (cmd) {
            case Cmd.PH_FLIP:
                void this._callGameFunction('planehunt_flip', {
                    roomId: this._roomId,
                    row: Number(data.row),
                    col: Number(data.col),
                    reqSeq,
                });
                break;

            case Cmd.GK_MOVE:
                void this._callGameFunction('gomoku_move', {
                    roomId: this._roomId,
                    row: Number(data.row),
                    col: Number(data.col),
                    reqSeq,
                });
                break;

            case Cmd.GAME_SURRENDER:
                void this._callGameFunction('settleGame', {
                    roomId: this._roomId,
                    // 投降：胜者由服务端判定为对手，客户端不指定
                    result: { winnerId: '', draw: false, reason: 'surrender' },
                });
                break;

            default:
                // 心跳等无需上行；真正的下行命令误发上来只告警，不抛错
                console.warn(`[WxNetSync] send(${cmd}) 无对应云函数映射，已忽略`);
                break;
        }
    }

    public onMessage(cb: NetMessageHandler): () => void {
        this._msgHandlers.push(cb);
        return () => {
            const i = this._msgHandlers.indexOf(cb);
            if (i >= 0) {
                this._msgHandlers.splice(i, 1);
            }
        };
    }

    public disconnect(): void {
        // 清掉所有在途看门狗：对局已离开，再冒一条「下行通道断」只会吓人。
        for (const t of this._watchdogs) {
            clearTimeout(t);
        }
        this._watchdogs.clear();
        this._closeWatch();
        this._setStatus(NetStatus.DISCONNECTED);
        console.log('[WxNetSync] 已断开');
    }

    /**
     * 重连并做全量对账。
     *
     * 必要性：watch 断线会自动重连但**只推增量** ——
     * 不做全量对账就会丢掉断线期间的棋步（表现为「棋子缺失」）。
     *
     * 触发时机：wx.onShow（切回前台）与 wx.onNetworkStatusChange。
     */
    public async reconnect(): Promise<void> {
        if (!this._roomId) {
            console.warn('[WxNetSync] 无房间上下文，无法重连');
            return;
        }

        this._setStatus(NetStatus.RECONNECTING);
        console.log('[WxNetSync] 重连中...');

        this._closeWatch();
        this._openWatch();

        this._setStatus(NetStatus.CONNECTED);

        // 请求全量对账：通知业务层重新拉取权威棋局状态
        // （业务层收到 GAME_RESYNC 后调用 getRoomState / 重新拉对局文档）
        this._dispatch(
            makeEnvelope(Cmd.GAME_RESYNC, this._roomId, this._playerId, { reason: 'reconnect' }),
        );

        console.log('[WxNetSync] 重连完成，已请求全量对账');
    }

    public getStatus(): NetStatus {
        return this._status;
    }

    public onStatusChange(cb: (status: NetStatus) => void): () => void {
        this._statusHandlers.push(cb);
        return () => {
            const i = this._statusHandlers.indexOf(cb);
            if (i >= 0) {
                this._statusHandlers.splice(i, 1);
            }
        };
    }

    public getPlayerId(): string {
        return this._playerId;
    }

    // ==================== 装配接口（由 ServiceLocator / 场景控制器调用） ====================

    /** 注入本机 playerId（登录后由场景控制器调用）。 */
    public setPlayerId(playerId: string): void {
        this._playerId = playerId;
        console.log(`[WxNetSync] playerId=${playerId}`);
    }

    /** 指定当前对局类型，决定监听哪个集合。 */
    public setGameId(gameId: GameId): void {
        this._gameId = gameId;
    }

    // ==================== 内部实现 ====================

    /**
     * 打开对局集合的 watch。
     *
     * 安全要点：**寻机头的权威布局绝不下发客户端** ——
     * 因此 gameId 为寻机头时只读取 flips（已翻格记录），
     * 绝不读取 cells 字段，也不把它放进任何下行消息。
     */
    private _openWatch(): void {
        const collection = this._collectionForGame();
        const roomId = this._roomId;

        // gameId 未设置 → 静默回落到监听 rooms，而 rooms 里**没有棋步**：
        // 上行写库一切正常、下行永远等不到（2026-09-24 真机踩过，日志只有一句
        // `gameId=未指定`，混在正常输出里完全看不见）。这里升级成显式告警。
        if (!this._gameId) {
            console.error(
                '[WxNetSync] gameId 未设置，watch 只能监听 rooms（无棋步数据）—— ' +
                    '对局下行必然收不到。调用方必须在 connect() 前 setGameId()（见 GameScene）。',
            );
        }

        this._unwatch = this._watchCollection(collection, { roomId }, (docs) => {
            if (!docs || docs.length === 0) {
                return;
            }
            this._handleGameDoc(docs[0]);
        });
    }

    /** 按游戏类型选择集合。 */
    private _collectionForGame(): string {
        if (this._gameId === GameId.PLANE_HUNT) {
            return COLLECTIONS.GAMES_PLANEHUNT;
        }
        if (this._gameId === GameId.GOMOKU) {
            return COLLECTIONS.GAMES_GOMOKU;
        }
        // 未指定游戏时监听 rooms（可感知开局/结束，但不含棋步）
        return COLLECTIONS.ROOMS;
    }

    /**
     * watch 集合（薄封装，便于将来替换为 WebSocket 实现）。
     *
     * 这里不直接依赖 ICloudService 是为了避免 ServiceLocator 注入顺序问题；
     * 直接用 wx.cloud（本文件与 WxCloudService 同在 services/wx 白名单内）。
     */
    private _watchCollection(
        name: string,
        query: Record<string, unknown>,
        cb: (docs: GameDoc[]) => void,
    ): () => void {
        let watcher: WxCloudWatcher | null = null;
        let closed = false;

        try {
            watcher = wx.cloud
                .database()
                .collection<GameDoc>(name)
                .where(query)
                .watch({
                    onChange: (snapshot: WxCloudDocumentSnapshot<GameDoc>) => {
                        if (closed) {
                            return;
                        }
                        try {
                            cb(snapshot.docs ?? []);
                        } catch (err) {
                            console.error(`[WxNetSync] watch(${name}) 回调异常:`, err);
                        }
                    },
                    onError: (err: unknown) => {
                        console.error(`[WxNetSync] watch(${name}) 错误:`, err);
                        // 连接异常 → 状态置为 RECONNECTING，交由 onShow/网络回调触发 reconnect
                        this._setStatus(NetStatus.RECONNECTING);
                    },
                });
            console.log(`[WxNetSync] 已监听 ${name} roomId=${this._roomId}`);
        } catch (err) {
            console.error(`[WxNetSync] watch(${name}) 建立失败:`, err);
            return () => undefined;
        }

        return () => {
            if (closed) {
                return;
            }
            closed = true;
            try {
                const r = watcher?.close();
                if (r && typeof (r as Promise<void>).catch === 'function') {
                    (r as Promise<void>).catch(() => undefined);
                }
            } catch (err) {
                console.warn(`[WxNetSync] close(${name}) 异常:`, err);
            }
        };
    }

    /** 关闭当前 watch（幂等）。 */
    private _closeWatch(): void {
        if (this._unwatch) {
            try {
                this._unwatch();
            } catch (err) {
                console.warn('[WxNetSync] 取消 watch 异常:', err);
            }
            this._unwatch = null;
        }
    }

    /**
     * 处理对局文档变更 → 派发增量下行消息。
     *
     * 幂等性：用 moveCount / flips.length 与上次记录比对，
     * 只派发新增部分 —— 重连后 watch 会重放全量快照，不去重会导致棋步重复应用。
     */
    private _handleGameDoc(doc: GameDoc): void {
        // 任何一条 watch 下行到达 → 计数 +1（所有看门狗的基线比对都靠它）。
        // 放在最前面：即使这一帧不含增量（moveCount 没变），也证明确实「收到了下行」。
        this._watchAckCount++;

        // ---- 五子棋 ----
        if (this._gameId === GameId.GOMOKU) {
            const moveCount = typeof doc.moveCount === 'number' ? doc.moveCount : 0;
            if (moveCount > this._lastMoveCount && doc.lastMove) {
                const lm = doc.lastMove;
                // ⚠️ nextPlayerId 的取值顺序是有讲究的（2026-09-24 真机事故）：
                //    以前只写 `doc.currentPlayerId ?? ''`，而这个字段在**历史棋局文档**
                //    里可能不存在（startGame 当年不落库 currentPlayerId），于是派发出去
                //    的 nextPlayerId 恒为空串 → 客户端 `isMyTurn()` 恒 false →
                //    「点棋盘没有任何反应」。
                //    现在优先取 **lastMove.nextPlayerId**（云函数逐手写入，一定存在），
                //    再回落到文档的 currentPlayerId；两者都没有时给出**明确的告警**
                //    而不是静默地派发空串 —— 后者会让问题在真机上完全不可见。
                const nextPlayerId = lm.nextPlayerId ?? doc.currentPlayerId ?? '';
                if (!nextPlayerId) {
                    console.warn(
                        '[WxNetSync] lastMove.nextPlayerId 与 doc.currentPlayerId 都为空 —— ' +
                            '客户端将无法判断回合。请确认 gomoku_move 云函数已更新到' +
                            '「lastMove 带 nextPlayerId」的版本并重新部署。',
                    );
                }
                this._dispatch(
                    makeEnvelope(Cmd.GK_MOVE_RESULT, this._roomId, lm.playerId, {
                        row: lm.row,
                        col: lm.col,
                        stone: lm.stone,
                        playerId: lm.playerId,
                        win: !!doc.winnerId,
                        winLine: [],
                        draw: false,
                        nextPlayerId,
                    }),
                );
                this._lastMoveCount = moveCount;
            }
        }

        // ---- 寻机头 ----
        if (this._gameId === GameId.PLANE_HUNT) {
            const flips = Array.isArray(doc.flips) ? doc.flips : [];
            if (flips.length > this._lastFlipCount) {
                // 只派发新增的翻格记录（增量）
                for (let i = this._lastFlipCount; i < flips.length; i++) {
                    this._dispatch(
                        makeEnvelope(Cmd.PH_FLIP_RESULT, this._roomId, this._playerId, flips[i]),
                    );
                }
                this._lastFlipCount = flips.length;
            }
            // 安全：绝不读取 / 派发 doc.cells（权威布局）
        }

        // ---- 结束状态 ----
        if (doc.finished && !this._gameOverDispatched) {
            this._gameOverDispatched = true;
            this._dispatch(
                makeEnvelope(Cmd.GAME_OVER, this._roomId, this._playerId, {
                    winnerId: (doc.winnerId as string) ?? '',
                    draw: !doc.winnerId,
                    reason: 'win',
                    stats: [],
                }),
            );
        }
    }

    /** 调用对局云函数（上行）。失败只告警，避免打断本地交互。 */
    private async _callGameFunction(
        name: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        // ── 看门狗：watch 下行回执监视 ──
        // ⚠️ 计时必须在**发出请求之前**开始（2026-09-24 真机日志实锤的误报）。
        //   旧实现在 callFunction **返回之后**才 arm —— 但 watch 下行经常比
        //   Promise 返回更早到（用户日志时序：↓ gk.move.result ×2 出现在
        //   ↑ 已受理 之前）。arm 时把「已收到的下行」清零，之后自然
        //   「4 秒无下行」→ 每次落子都误报一次「下行通道断」。
        //   现在：arm 时记下**当前下行计数为基线**，请求发出后的任何一条下行
        //   （哪怕到得比返回快）都会使计数超过基线 → 超时比对不通过 → 静默。
        //
        // 上行失败时直接 cancel —— 错误已当场打出（下面各分支），
        // 没必要 4 秒后再补一句；「该往哪查」写进各条即时日志里
        // （旧版把「云端未装依赖」的提示放进阶梯超时里，结果误导过一次排查）。
        const baseline = this._watchAckCount;
        const watchdog = setTimeout(() => {
            this._watchdogs.delete(watchdog);
            if (this._watchAckCount > baseline) {
                return; // 请求发出后收到过下行 → 通道正常，静默
            }
            console.error(
                `[WxNetSync] WATCH_ACK_TIMEOUT：${name} 请求已发出，但 ` +
                    `${WATCH_ACK_TIMEOUT_MS}ms 内没有任何 watch 下行。两个排查方向：` +
                    `① 上方「已监听 xxx」日志 —— 集合必须是 games_gomoku/games_planehunt，` +
                    `若是 rooms 说明 setGameId 没调（监听错了集合，收不到棋步）；` +
                    `② 云开发控制台的集合权限：rooms / games_gomoku / games_planehunt ` +
                    `必须设为「所有用户可读」，否则 watch 静默失败（无报错也无回调）。`,
            );
        }, WATCH_ACK_TIMEOUT_MS);
        this._watchdogs.add(watchdog);
        const cancelWatchdog = (): void => {
            clearTimeout(watchdog);
            this._watchdogs.delete(watchdog);
        };

        try {
            const res = await wx.cloud.callFunction({ name, data });
            const envelope = (res as { result?: { success?: boolean; code?: number; message?: string } })
                .result;

            if (envelope && envelope.success === false) {
                cancelWatchdog();
                console.warn(
                    `[WxNetSync] ${name} 业务失败 code=${envelope.code} msg=${envelope.message}`,
                );
                // 把服务端错误下发给业务层（可用于提示「还没轮到你」等）
                this._dispatch(
                    makeEnvelope(Cmd.SYS_ERROR, this._roomId, this._playerId, {
                        code: envelope.code ?? ERR.UNKNOWN,
                        message: envelope.message ?? '操作失败',
                        cmd: name,
                    }),
                );
                return;
            }

            if (!envelope) {
                // ⚠️ 这一条曾经是「静默吞掉」的：wx 在云函数**未部署**时不会 reject，
                //    而是把 { errCode, errMsg } 塞进 result 并 resolve。以前只判
                //    success===false，于是「未部署」被当成功，客户端继续死等 watch
                //    （watch 又没有数据），表现为「落子无反应 + 卡在对手思考中」，
                //    且**一条日志都没有**。这里显式暴露。
                cancelWatchdog();
                const raw = res as { errCode?: number; errMsg?: string };
                console.error(
                    `[WxNetSync] ${name} 返回体为空（疑似云函数未部署 / 未返回信封）` +
                        ` errCode=${raw?.errCode ?? '无'} errMsg=${raw?.errMsg ?? '无'}；` +
                        `最常见原因是云端未安装依赖 —— 用 ` +
                        `node tools/deploy-cloudfunctions.js（带 --remote-npm-install）重新部署`,
                );
                this._dispatch(
                    makeEnvelope(Cmd.SYS_ERROR, this._roomId, this._playerId, {
                        code: ERR.BAD_RESPONSE,
                        message: `云函数 ${name} 无有效返回（检查是否已部署）`,
                        cmd: name,
                    }),
                );
                return;
            }

            if (envelope.success === true) {
                // 成功且已受理：保留看门狗 —— 「受理」只证明写库，
                // 不证明 watch 推得回来（两条通道独立）。
                console.log(
                    `[WxNetSync] ↑ ${name} 已受理 code=${envelope.code}`,
                );
            } else {
                // success 既非 true 也非 false：形状不认识，按失败处理，别死等
                cancelWatchdog();
                console.error(
                    `[WxNetSync] ${name} 信封形状异常（success=${String(envelope.success)}），` +
                        `原始返回=${JSON.stringify(res).slice(0, 200)}`,
                );
            }
            // 注意：成功时不在此派发棋步 —— 棋步由 watch 下行统一派发，
            // 保证「本机操作」与「对手操作」走完全相同的路径（与 Mock 语义一致）。
        } catch (err) {
            cancelWatchdog();
            const msg = (err as { errMsg?: string })?.errMsg ?? String(err);
            console.error(
                `[WxNetSync] ${name} 调用失败: ${msg}` +
                    (msg.includes('Cannot find module')
                        ? ' —— 云端缺依赖：用 node tools/deploy-cloudfunctions.js ' +
                          '（带 --remote-npm-install）重新部署该函数'
                        : ''),
            );
            this._dispatch(
                makeEnvelope(Cmd.SYS_ERROR, this._roomId, this._playerId, {
                    code: ERR.CALL_FAIL,
                    message: `网络异常(${name})`,
                    cmd: name,
                }),
            );
        }
    }

    /** 派发一条下行消息给所有订阅者。 */
    private _dispatch(msg: NetMessage): void {
        if (msg.cmd !== Cmd.GAME_RESYNC && msg.cmd !== Cmd.SYS_ERROR) {
            console.log(`[WxNetSync] ↓ 下行 ${msg.cmd}`, msg.payload);
        }
        for (const cb of this._msgHandlers.slice()) {
            try {
                cb(msg);
            } catch (err) {
                console.error(`[WxNetSync] 消息处理异常 ${msg.cmd}:`, err);
            }
        }
    }

    private _setStatus(s: NetStatus): void {
        if (this._status === s) {
            return;
        }
        this._status = s;
        for (const cb of this._statusHandlers.slice()) {
            try {
                cb(s);
            } catch (err) {
                console.error('[WxNetSync] 状态回调异常:', err);
            }
        }
    }
}
