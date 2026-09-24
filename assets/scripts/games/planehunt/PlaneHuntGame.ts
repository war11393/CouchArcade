/**
 * 寻机头对局模块（实现 IGame）。
 *
 * 与五子棋同构：双模式共用一套规则与 UI，仅数据源不同。
 *
 * 权威模型（规格关键要求）：
 * - 布局权威方抽象为 ILayoutProvider；
 * - 第一阶段：联机/Mock 模式由本地规则层担任权威（经 MockSync 下发翻格结果）；
 * - 第二阶段：切换为云函数生成 + 加密存储，客户端始终只按格查询结果，杜绝篡改。
 */

import { AiLevel, AppConfig } from '../../config/AppConfig';
import { GameId } from '../../config/GameList';
import { INetSyncService, NetMessage } from '../../core/services/IServices';
import { Cmd, PhFlipResultPayload } from '../../core/protocol/Protocol';
import { GameContext, GameMode, GameResult, IGame } from '../common/IGame';
import { IMockAuthority } from '../../core/services/mock/MockNetSyncService';
import { services } from '../../core/ServiceLocator';
import { PlaneHuntAi } from './PlaneHuntAi';
import { PlaneHuntRules } from './PlaneHuntRules';
import { PlaneHuntBoard } from './PlaneHuntBoard';
import { CELL_HEAD } from './PlaneHuntLayout';

/**
 * 寻机头权威裁判（Mock 阶段由本地规则层担任）。
 *
 * 输入输出与真实云函数（cloudfunctions/planehunt_flip）完全一致：
 * 上行 { cmd: ph.flip, payload: { row, col, reqSeq } }
 * 下行 { cmd: ph.flip.result, payload: PhFlipResultPayload }
 *
 * 安全性说明：客户端永远拿不到布局，只能逐格询问结果，
 * 因此第一阶段即可验证「防篡改」的架构正确性。
 */
export class PlaneHuntAuthority implements IMockAuthority {
    private readonly _rules: PlaneHuntRules;
    private readonly _ai: PlaneHuntAi | null;
    private readonly _aiPlayerId: string;
    private readonly _roomId: string;
    private readonly _handled = new Set<number>();
    private _aiBusy = false;
    /** AI 待执行的动作（思考延迟结束后取出）。 */
    private _aiPending: { row: number; col: number } | null = null;

    constructor(
        roomId: string,
        firstPlayerId: string,
        secondPlayerId: string,
        aiPlayerId: string,
        seed: number,
        level: AiLevel,
    ) {
        this._roomId = roomId;
        this._rules = new PlaneHuntRules(firstPlayerId, secondPlayerId, seed);
        this._aiPlayerId = aiPlayerId;
        this._ai = aiPlayerId ? new PlaneHuntAi(level) : null;
    }

    public get rules(): PlaneHuntRules {
        return this._rules;
    }

    /** 处理上行翻格请求。 */
    public handleUpstream(msg: NetMessage): NetMessage[] {
        if (msg.cmd !== Cmd.PH_FLIP) {
            return [];
        }
        const p = msg.payload as { row: number; col: number; reqSeq: number };

        if (this._handled.has(p.reqSeq)) {
            console.warn(`[PlaneHuntAuthority] 重复请求 reqSeq=${p.reqSeq}，已忽略`);
            return [];
        }
        this._handled.add(p.reqSeq);

        const result = this._rules.applyFlip(p.row, p.col, msg.playerId);
        if (!result) {
            return [
                this._mk(msg.playerId, Cmd.SYS_ERROR, {
                    code: 4000,
                    message: '非法翻格',
                    cmd: Cmd.PH_FLIP,
                }),
            ];
        }

        const out: NetMessage[] = [this._mk(msg.playerId, Cmd.PH_FLIP_RESULT, result)];
        if (this._rules.finished) {
            out.push(this._gameOver());
        }
        return out;
    }

    /**
     * AI 行动。
     *
     * 注意「机头奖励连翻」的处理：AI 翻中机头后会连续行动，
     * 本方法在每次轮询中被调用，因此能自然地连续出手（每次一个 tick）。
     */
    public pollAiAction(): NetMessage[] {
        if (!this._ai || this._rules.finished) {
            return [];
        }
        if (this._rules.currentPlayerId !== this._aiPlayerId) {
            this._aiPending = null;
            return [];
        }

        // 思考中：等待延迟结束
        if (this._aiBusy) {
            return [];
        }

        // 若已有待执行动作，执行它
        if (this._aiPending) {
            const act = this._aiPending;
            this._aiPending = null;
            const result = this._rules.applyFlip(act.row, act.col, this._aiPlayerId);
            if (!result) {
                return [];
            }
            const out: NetMessage[] = [this._mk(this._aiPlayerId, Cmd.PH_FLIP_RESULT, result)];
            if (this._rules.finished) {
                out.push(this._gameOver());
            }
            return out;
        }

        // 计算并安排下一次动作（模拟思考延迟）
        const decision = this._ai.decide(this._rules);
        if (!decision) {
            return [];
        }
        this._aiPending = { row: decision.row, col: decision.col };
        this._aiBusy = true;
        const delay = PlaneHuntAi.thinkDelayMs();
        setTimeout(() => {
            this._aiBusy = false;
        }, delay);

        return [];
    }

    public onConnect(): NetMessage[] {
        // 下发布局元信息（尺寸/飞机数），不含明文机头坐标
        return [
            this._mk(this._aiPlayerId, Cmd.PH_LAYOUT, {
                size: this._rules.size,
                planeCount: this._rules.totalHeads,
            }),
        ];
    }

    public onResync(): NetMessage[] {
        // 断线重连：把已揭示的格子全部重放（幂等）
        return this._rules.allRevealed().map((rev) =>
            this._mk(rev.byPlayerId, Cmd.PH_FLIP_RESULT, {
                row: rev.row,
                col: rev.col,
                cell: rev.cell,
                byPlayerId: rev.byPlayerId,
                scored: rev.cell === CELL_HEAD,
                extraTurn: false,
                headsFound: this._rules.headsFound,
                score: this._rules.scoreOf(rev.byPlayerId),
                nextPlayerId: this._rules.currentPlayerId,
                planeIndex: rev.planeIndex,
            } as PhFlipResultPayload),
        );
    }

    private _gameOver(): NetMessage {
        return this._mk(this._aiPlayerId, Cmd.GAME_OVER, {
            winnerId: this._rules.winnerId,
            draw: this._rules.isDraw,
            reason: this._rules.isDraw ? 'draw' : 'win',
            stats: this._rules.allScores().map((s) => ({
                playerId: s.playerId,
                score: s.score,
                moves: s.moves,
            })),
        });
    }

    private _mk(playerId: string, cmd: string, payload: unknown): NetMessage {
        return {
            cmd,
            roomId: this._roomId,
            playerId,
            payload,
            timestamp: Date.now(),
        };
    }
}

/**
 * 寻机头 IGame 实现。
 */
export class PlaneHuntGame implements IGame {
    public readonly gameId = GameId.PLANE_HUNT;

    private readonly _ctx: GameContext;
    private _board: PlaneHuntBoard | null = null;
    private _rules: PlaneHuntRules | null = null;
    private _unsub: (() => void) | null = null;
    private _reqSeq = 0;
    private _finished = false;
    private _result: GameResult | null = null;
    private _startTime = 0;
    /**
     * 权威下发的「当前该谁行动」。
     *
     * 客户端本地 _rules 是独立实例，其回合状态不会随对局推进
     * （客户端只提交翻格请求、接收结果，不自行改棋局）。
     * 因此回合判定必须用权威下发值，否则 isMyTurn() 恒为 false，
     * 表现为「点击棋盘没有任何反应」。
     */
    private _serverTurnId = '';

    /** 我点了、正在等权威判定的那一格（null = 没有）。 */
    private _pending: { row: number; col: number } | null = null;
    /** 上一次上行的时刻（用于 AI 一手的「最小思考感」）。 */
    private _sentAt = 0;
    /** 对手一手延迟应用的定时器（卸载时必须清）。 */
    private _aiHoldTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * 对手一手的展示延迟下限（毫秒）。
     *
     * 与五子棋 `GomokuGame.AI_MIN_THINK_MS` 同一个理由：服务端把人类与 AI
     * 两手背靠背写库，两帧 watch 只差几百毫秒，不补间隔会「两颗子同时蹦出来」。
     * 寻机头同样存在（人类翻一格 → AI 立刻回翻一格）。
     */
    private static readonly AI_MIN_THINK_MS = 650;

    constructor(ctx: GameContext) {
        this._ctx = ctx;
    }

    public init(ctx: GameContext): void {
        this._ctx.mode = ctx.mode;
    }

    /** 注入视图。 */
    public attachView(board: PlaneHuntBoard): void {
        this._board = board;
    }

    public onEnter(): void {
        this._startTime = Date.now();
        const { room, myPlayerId, opponent, seed, firstPlayerId } = this._ctx;

        const first = firstPlayerId || room.seats[0].playerId;
        const second = first === myPlayerId ? opponent.playerId : myPlayerId;
        // 本地规则实例仅用于渲染（客户端不知道布局，翻格结果由权威下发）
        this._rules = new PlaneHuntRules(first, second, seed);
        // 初始回合 = 先手方（与权威构造时的 currentPlayerId 一致）
        this._serverTurnId = first;

        if (this._board) {
            this._board.setup(myPlayerId, first);
            this._board.renderGrid();
        }

        const net = this._getNetSync();
        if (net) {
            this._unsub = net.onMessage((m) => this.onSyncMessage(m));
            void net.connect(room.roomId);
        }

        console.log(
            `[PlaneHuntGame] 进入对局 mode=${this._ctx.mode} seed=${seed} 先手=${first} ` +
                `我方=${myPlayerId} 对手=${opponent.playerId}`,
        );
    }

    public onSyncMessage(msg: NetMessage): void {
        switch (msg.cmd) {
            case Cmd.PH_FLIP_RESULT: {
                const p = msg.payload as PhFlipResultPayload;
                this._applyFlipResult(p);
                break;
            }
            case Cmd.PH_LAYOUT: {
                // 布局元信息（第二阶段用于显示进度条上限）
                break;
            }
            case Cmd.SYS_ERROR: {
                // 权威拒绝了我刚上行的翻格（如「还没轮到你翻格」）：
                // 撤掉本地「判定中」的预反馈标记并放开输入，否则那一格会永远
                // 显示成"等待判定"，且棋盘一直不可点 —— 玩家以为卡死了。
                // ⚠️ cmd 取值两端不同：Mock 裁判填协议名（ph.flip），
                //    真机 WxNetSync 填**云函数名**（planehunt_flip）—— 两个都认。
                const e = msg.payload as { cmd?: string; message?: string };
                const mine = e && (e.cmd === Cmd.PH_FLIP || e.cmd === 'planehunt_flip');
                if (mine && this._pending) {
                    this._rollbackPending();
                }
                break;
            }
            case Cmd.GAME_OVER: {
                const p = msg.payload as {
                    winnerId: string;
                    draw: boolean;
                    reason: GameResult['reason'];
                };
                this._finishGame(p.winnerId, p.draw, p.reason);
                break;
            }
            default:
                break;
        }
    }

    public onAiTurn(): void {
        if (this._board) {
            this._board.showThinking(true);
        }
    }

    public onExit(): void {
        if (this._aiHoldTimer) {
            clearTimeout(this._aiHoldTimer);
            this._aiHoldTimer = null;
        }
        if (this._unsub) {
            this._unsub();
            this._unsub = null;
        }
        this._getNetSync()?.disconnect();
        this._board = null;
        console.log('[PlaneHuntGame] 退出对局');
    }

    public getResult(): GameResult | null {
        return this._result;
    }

    public isFinished(): boolean {
        return this._finished;
    }

    public isMyTurn(): boolean {
        if (!this._rules || this._finished) {
            return false;
        }
        // 优先用「权威下发的回合」判断。
        // 本地 _rules 是独立实例（客户端拿不到布局，也不该改棋局状态），
        // 它的 currentPlayerId 不会随对局推进 —— 直接读它会导致
        // 我方回合恒为 false（症状：点了棋盘没有任何反应）。
        const who = this._serverTurnId || this._rules.currentPlayerId;
        return who === this._ctx.myPlayerId;
    }

    // ==================== 玩家操作 ====================

    /**
     * 玩家点击格子（由 PlaneHuntBoard 回调）。
     *
     * 双模式统一走协议：只发送翻格请求，翻格结果完全由权威方下发。
     * 这保证了客户端无法通过改内存作弊（与第二阶段云函数规范一致）。
     *
     * ⚠️ 与五子棋的「预落子」不同（2026-09-24 一致性修复）：
     *   寻机头的翻格结果**客户端不可预知**（布局在服务端），所以不能乐观渲染
     *   "翻出了什么"。但手感诉求一样：点下去必须立刻有反应。这里给的等价反馈是
     *   ——立刻在该格放一个「判定中」标记 + 禁用棋盘输入，等权威结果到达后
     *   `_applyFlipResult` 再用正式标记覆盖。这样玩家点完立刻看到反馈，
     *   而不是盯着没反应的棋盘等一个网络往返。
     */
    public onPlayerClick(row: number, col: number): void {
        if (this._finished || !this._rules) {
            return;
        }
        if (!this.isMyTurn()) {
            return;
        }
        if (this._rules.isRevealed(row, col)) {
            return;
        }

        const net = this._getNetSync();
        if (!net) {
            console.warn('[PlaneHuntGame] 无同步通道，无法翻格');
            return;
        }

        this._reqSeq++;
        this._sentAt = Date.now();
        this._pending = { row, col };
        // 立即反馈 + 锁输入（防止等待期连点发出一串请求）
        if (this._board) {
            this._board.setPendingCell(row, col);
            this._board.setInputEnabled(false);
        }
        net.send(Cmd.PH_FLIP, { row, col, reqSeq: this._reqSeq });
    }

    public surrender(): void {
        if (this._finished) {
            return;
        }
        const net = this._getNetSync();
        net?.send(Cmd.GAME_SURRENDER, { playerId: this._ctx.myPlayerId });
        this._finishGame(this._ctx.opponent.playerId, false, 'surrender');
    }

    public sendEmote(emoteId: number): void {
        this._getNetSync()?.send(Cmd.GAME_EMOTE, { emoteId });
    }

    // ==================== 内部 ====================

    private _applyFlipResult(p: PhFlipResultPayload): void {
        if (!this._rules) {
            return;
        }

        // ⚠️ 字段容错（2026-09-24 真机事故的防御层）：
        //   云函数历史版本的 flips[] 只写 playerId，客户端读 byPlayerId 得到
        //   undefined → 归属判定失败、HUD 显示 undefined、回合判定恒 false
        //   → 「我的回合无法落子」。
        //   服务端已补齐字段，但**断线重连会重放旧数据**，所以这里仍然兜一层：
        //   缺 byPlayerId 时回落到 playerId；缺 nextPlayerId 时保持当前回合不变
        //   （而不是把 undefined 灌进去让回合判定恒 false）。
        const raw = p as unknown as Record<string, unknown>;
        const byPlayerId = (p.byPlayerId ?? raw.playerId ?? '') as string;
        if (!byPlayerId || !p.nextPlayerId) {
            console.warn(
                '[PlaneHuntGame] PH_FLIP_RESULT 字段缺失，已兜底：' +
                    `byPlayerId=${String(p.byPlayerId)}→${byPlayerId || '(空)'} ` +
                    `nextPlayerId=${String(p.nextPlayerId)}→${p.nextPlayerId || '(保持当前回合)'}`,
            );
        }

        // 我预反馈的那一格：权威结果到了 → 撤掉「判定中」标记。
        // 必须在幂等短路**之前**清 —— 否则重连重放同一格时标记会永远留着。
        const isMyPending = this._pending
            && this._pending.row === p.row && this._pending.col === p.col;
        if (isMyPending) {
            this._pending = null;
            this._board?.clearPendingCell();
        }

        // 幂等：已揭示的格子跳过（重连全量补偿时会重复下发）
        if (this._rules.isRevealed(p.row, p.col)) {
            return;
        }

        // 对手（AI）的一手：补足最小展示间隔再应用 —— 与五子棋同款手感修正。
        // 计时起点是我方上行的时刻；AI 真实耗时若已超过下限则不再额外拖。
        const byMeNow = p.byPlayerId === this._ctx.myPlayerId;
        const hold = Math.max(0, PlaneHuntGame.AI_MIN_THINK_MS - (Date.now() - this._sentAt));
        if (!byMeNow && hold > 0) {
            if (this._aiHoldTimer) {
                clearTimeout(this._aiHoldTimer);
            }
            this._aiHoldTimer = setTimeout(() => {
                this._aiHoldTimer = null;
                this._commitFlip(p);
            }, hold);
            return;
        }
        this._commitFlip(p);
    }

    /** 应用一格翻格结果（延迟窗口结束后；见 _applyFlipResult 的注释）。 */
    private _commitFlip(p: PhFlipResultPayload): void {
        if (!this._rules || this._finished) {
            return;
        }
        // 二次幂等：延迟期间可能已有别的帧把它翻了（重连重放）
        if (this._rules.isRevealed(p.row, p.col)) {
            return;
        }

        // ── 字段容错（真机事故的防御层，见 _applyFlipResult 的说明）──
        // 缺 byPlayerId → 回落 playerId（旧版云函数只写这个）；
        // 缺 nextPlayerId → **保持当前回合不变**，而不是灌 undefined
        //   （灌进去会让 isMyTurn() 恒 false → 玩家「无法落子」）；
        // 缺 headsFound/score → 用棋盘现有值，不显示 undefined。
        const raw = p as unknown as Record<string, unknown>;
        const byPlayerId = (p.byPlayerId || (raw.playerId as string) || '') as string;
        const nextPlayerId = (p.nextPlayerId || this._serverTurnId || '') as string;
        const headsFound = typeof p.headsFound === 'number'
            ? p.headsFound
            : (this._board ? this._board.getHeadsFound() : 0);
        const score = typeof p.score === 'number'
            ? p.score
            : (this._board ? (byPlayerId === this._ctx.myPlayerId ? this._board.getMyScore() : this._board.getOppScore()) : 0);

        // 记录权威下发的回合 —— 客户端不自行推演棋局，
        // 回合判定唯一依据就是这里（见 _serverTurnId 的说明）。
        const prevTurn = this._serverTurnId;
        this._serverTurnId = nextPlayerId;
        // 注意：不要往本地 rules 里塞 nextPlayerId —— 改本地规则等于客户端自行
        // 推演棋局，与「布局/判定全在权威方」的防篡改设计相悖。
        // 「哪些格已翻开」由 PlaneHuntBoard 自维护（见 revealCell / isRevealedInBoard）。

        if (this._board) {
            this._board.showThinking(false);
            // 归属按 byPlayerId 判定（信封里的 playerId 是权威代发的发送者，
            // 对 AI 出手来说那是 AI 自己，不能用它判断「是不是我翻的」）
            const byMe = byPlayerId === this._ctx.myPlayerId;
            this._board.revealCell(p.row, p.col, p.cell, byMe, p.scored, score);
            this._board.setTurn(nextPlayerId === this._ctx.myPlayerId, headsFound, this._headTotal());
        }

        // 翻中机头：给一次视觉反馈（**不再**奖励连翻，见 PlaneHuntRules 说明）。
        // 反馈只看 scored，不看 extraTurn —— 后者在当前规则下恒为 false。
        if (p.scored && this._board) {
            this._board.showScoreTip();
        }

        // ⚠️ 必须用权威回合 + 未结束来重算输入开关。
        //    只在这里设置输入状态，且条件含 nextPlayerId —— 曾经漏了这步，
        //    导致回合切回我方时棋盘仍是「不可点」的。
        const myTurnNow = !this._finished && nextPlayerId === this._ctx.myPlayerId;
        if (this._board) {
            this._board.setInputEnabled(myTurnNow);
        }
        if (prevTurn !== this._serverTurnId && AppConfig.LOG_VERBOSE) {
            console.log(
                `[PlaneHuntGame] 回合切换：${prevTurn || '(空)'} → ${this._serverTurnId || '(空)'}，我方回合=${myTurnNow}`,
            );
        }
    }

    /** 机头总数（从房间配置推导，第一阶段固定 5）。 */
    private _headTotal(): number {
        return this._rules ? this._rules.totalHeads : 5;
    }

    /**
     * 撤销本地「判定中」的预反馈（权威拒绝时）。
     *
     * 寻机头不像五子棋要回滚棋子（本来就没乐观落子），这里只需要：
     *   ① 撤掉待判定标记；② 放开棋盘输入让玩家重试。
     */
    private _rollbackPending(): void {
        if (!this._pending) {
            return;
        }
        this._pending = null;
        if (this._board) {
            this._board.clearPendingCell();
            this._board.setInputEnabled(!this._finished && this.isMyTurn());
        }
    }

    private _finishGame(winnerId: string, draw: boolean, reason: GameResult['reason']): void {
        if (this._finished) {
            return;
        }
        this._finished = true;

        const myId = this._ctx.myPlayerId;
        const oppId = this._ctx.opponent.playerId;
        const myScore = this._board ? this._board.getMyScore() : 0;
        const oppScore = this._board ? this._board.getOppScore() : 0;

        this._result = {
            gameId: this.gameId,
            winnerId,
            draw,
            reason,
            stats: [
                {
                    playerId: myId,
                    nickname: this._nickOf(myId),
                    score: myScore,
                    moves: this._board ? this._board.getMyFlips() : 0,
                },
                {
                    playerId: oppId,
                    nickname: this._nickOf(oppId),
                    score: oppScore,
                    moves: this._board ? this._board.getOppFlips() : 0,
                },
            ],
            durationMs: Date.now() - this._startTime,
        };

        if (this._board) {
            this._board.setInputEnabled(false);
        }
        console.log(
            `[PlaneHuntGame] 对局结束 winner=${winnerId || '(平局)'} reason=${reason} ` +
                `比分=${myScore}:${oppScore} 用时=${(this._result.durationMs / 1000).toFixed(1)}s`,
        );
    }

    private _nickOf(playerId: string): string {
        const seat = this._ctx.room.seats.find((s) => s.playerId === playerId);
        return seat ? seat.nickname : playerId;
    }

    private _getNetSync(): INetSyncService | null {
        try {
            return services.netSync;
        } catch (err) {
            console.error('[PlaneHuntGame] 获取同步服务失败:', err);
            return null;
        }
    }

    public get mode(): GameMode {
        return this._ctx.mode;
    }
}
