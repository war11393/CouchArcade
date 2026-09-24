/**
 * Room 场景控制器（房间/座位系统）。
 *
 * 状态机（规格要求）：
 *   WAITING（等待玩家入座）→ READY（全员就位，房主可开局）
 *     → PLAYING（进入对局）→ FINISHED
 *   异常分支：DISSOLVED（超时解散）、断线重连、中途退出
 *
 * **两种模式的开局路径不同**（改这里前务必分清）：
 *   · AI 练习（mode='ai' / isPractice=true）：**没有准备环节** ——
 *     AI 座位由服务端建房时置 ready=true，房主免准备，房间建好即自动开局；
 *     「准备」按钮在练习房隐藏（见 _setReadyButtonVisible）。
 *   · 联机（mode='pvp'）：**必须全员准备**（含房主自己）才自动开局，
 *     status 由服务端 ready 云函数推进到 READY。房主没有免准备特权。
 *   两套判定必须与服务端 startGame 的口径一致，否则会出现
 *   「客户端说能开局、服务端却拒绝」（历史事故，见 test-cloud-ai-seat.js）。
 *
 * ⚠️ UI 是【静态节点】，定义在 tools/ui-trees.js 的 roomTree()，由 gen-scenes.js
 * 编译进 Room.scene。本控制器**不再运行时创建 UI**（除模式弹窗浮层），只负责：
 *   1. 绑定已有节点（按路径查找）
 *   2. 驱动座位状态 / 按钮可用性
 *   3. 房间业务逻辑（创建/加入/准备/开局/退出/分享）
 *
 * 层级结构（可在编辑器层级管理器中看到）：
 *   Scene
 *    └─ Canvas                 [cc.Canvas, cc.UITransform, cc.Widget]
 *        ├─ Bg                 [cc.Graphics]
 *        ├─ Header             [cc.Graphics]
 *        │   ├─ RoomTitle      [cc.Label]
 *        │   └─ RoomId         [cc.Label]
 *        ├─ SeatTop            [cc.Graphics]     ← 对手
 *        │   ├─ SeatName / SeatStatus / SeatScore [cc.Label]
 *        ├─ VsLabel            [cc.Label]
 *        ├─ SeatBottom         [cc.Graphics]     ← 自己
 *        │   ├─ SeatName / SeatStatus / SeatScore [cc.Label]
 *        ├─ BtnBar               [贴底容器 cc.Widget]
 *        │   ├─ BtnReady           [cc.Button] → BtnReadyLabel
 *        │   └─ BtnLeave           [cc.Button] → BtnLeaveLabel
 *        ├─ SceneRoot          [RoomScene]   ← 本脚本
 *        └─ Camera             [cc.Camera]
 */

import { _decorator, Color, Component, Label, Node, Vec3 } from 'cc';
import { requireGameMeta } from '../config/GameList';
import { RoomState, RoomStatus, SeatInfo } from '../core/services/IServices';
import { services, ensureServices } from '../core/ServiceLocator';
import { GameEvent, eventBus } from '../core/EventBus';
import { GameSceneParams, RoomSceneParams, uiManager } from '../core/UIManager';
import { THEME, bindClick, findNode, setLabelText, hexToColor } from '../core/UIFactory';
import { portraitAdapter } from '../core/PortraitAdapter';

const { ccclass } = _decorator;

/** 座位在场景树中的路径（与 ui-trees.js 保持一致）。 */
const SEAT_PATHS = ['Canvas/SeatTop', 'Canvas/SeatBottom'];

@ccclass('RoomScene')
export class RoomScene extends Component {
    private _params: RoomSceneParams | null = null;
    private _unwatch: (() => void) | null = null;
    private _unroomMsg: (() => void) | null = null;

    /** 座位节点（静态，按 SEAT_PATHS 查找）。 */
    private _seatNodes: Node[] = [];
    private _myReady = false;
    private _isOwner = false;
    private _entered = false;
    /** 开局请求进行中（防止 watch 重复推送触发并发 startRoom）。 */
    private _starting = false;
    /** 「准备」按钮当前是否处于隐藏态（用于避免每次状态推送都重排按钮）。 */
    private _readyHidden = false;

    protected async onLoad(): Promise<void> {
        console.log('[RoomScene] onLoad 开始');
        ensureServices();
        this._params = uiManager.consumeRoomParams();
        if (!this._params) {
            console.warn('[RoomScene] 缺少进入参数，返回大厅');
            uiManager.gotoLobby();
            return;
        }
        console.log(
            `[RoomScene] 收到进入参数：gameId=${this._params.gameId} mode=${this._params.mode} joinRoomId=${this._params.joinRoomId ?? '(无)'}`,
        );

        // 竖版自适应：按机型重算设计分辨率 + 贴边条安全区避让（见 core/PortraitAdapter.ts）
        portraitAdapter.apply();
        portraitAdapter.applyEdgeInsets(this.node);

        this._bindNodes();
        await this._initRoom();
        console.log('[RoomScene] onLoad 完成（房间已初始化）');
    }

    protected onDestroy(): void {
        if (this._unwatch) { this._unwatch(); this._unwatch = null; }
        if (this._unroomMsg) { this._unroomMsg(); this._unroomMsg = null; }
        eventBus.offTarget(this);
    }

    /** 绑定静态场景节点 + 交互（不再创建 UI）。 */
    private _bindNodes(): void {
        const meta = requireGameMeta(this._params!.gameId);
        setLabelText(this.node, 'Canvas/Header/RoomTitle', meta.name);

        // 座位节点
        this._seatNodes = [];
        for (const p of SEAT_PATHS) {
            const n = findNode(this.node, p);
            if (!n) {
                console.warn(`[RoomScene] 缺少座位节点 ${p}（请检查 tools/ui-trees.js）`);
                continue;
            }
            this._seatNodes.push(n);
        }

        // 按钮
        bindClick(this.node, 'Canvas/BtnBar/BtnReady', () => void this._onToggleReady());
        bindClick(this.node, 'Canvas/BtnBar/BtnLeave', () => void this._onLeave());

        // 初始文案
        setLabelText(this.node, 'Canvas/SeatTop/SeatName', '等待加入…');
        setLabelText(this.node, 'Canvas/SeatTop/SeatStatus', '空位');
        setLabelText(this.node, 'Canvas/SeatBottom/SeatName', '等待加入…');
        setLabelText(this.node, 'Canvas/SeatBottom/SeatStatus', '空位');
        setLabelText(this.node, 'Canvas/BtnBar/BtnReady/BtnReadyLabel', '准  备');

        // ---- 短屏护栏（竖版自适应）----
        // 「座位卡 + VS + 状态」是一列整体：基准机型放得下 ⇒ 零改动；
        // 矮屏则整列平移到 Header(152) 与 BtnBar(200) 之间带的中心
        //（只平移不改尺寸，列内间距保持设计值）。
        const column = ['Canvas/SeatTop', 'Canvas/VsLabel', 'Canvas/SeatBottom', 'Canvas/Status']
            .map((p) => findNode(this.node, p))
            .filter((n): n is Node => !!n);
        if (column.length === 4) {
            portraitAdapter.fitBlockInBand(column, 152, 200);
        }
    }

    // ==================== 房间逻辑 ====================

    /** 初始化房间（创建/加入/AI 练习三种入口）。 */
    private async _initRoom(): Promise<void> {
        const params = this._params!;
        const room = services.room;
        const user = services.auth.getCachedUser();

        if (!user) {
            await services.auth.login();
        }

        try {
            let state: RoomState;
            if (params.joinRoomId) {
                console.log(`[RoomScene] 尝试加入房间 ${params.joinRoomId}`);
                state = await room.joinRoom(params.joinRoomId);
            } else {
                console.log(`[RoomScene] 创建房间（模式=${params.mode}）`);
                state = await room.createRoom(params.gameId, params.mode === 'ai', params.aiLevel);
            }

            this._unwatch = room.watchRoom((s) => this._onRoomState(s));
            this._onRoomState(state);

            if (services.room instanceof Object && 'onRoomMessage' in services.room) {
                const r = services.room as unknown as {
                    onRoomMessage: (cb: (cmd: string, payload: unknown) => void) => () => void;
                };
                this._unroomMsg = r.onRoomMessage((cmd, payload) => this._onRoomMessage(cmd, payload));
            }

            this._setupShare();

            if (params.mode === 'ai') {
                // AI 练习：**没有准备环节**。
                // AI 座位由服务端建房时置 ready=true，房主（自己）免准备，
                // 房间建好即满足开局条件 → 下面的 _onRoomState 会自动开局。
                // 这里只更新提示文案，不再要求用户点「准备」。
                console.log('[RoomScene] AI 练习模式：无准备环节，等待自动开局');
                this._setStatus('AI 对手已就位，正在开始对局…');
            }
        } catch (err) {
            console.error('[RoomScene] 初始化房间失败:', err);
            uiManager.toast(`进入房间失败：${(err as Error).message}`, undefined);
            uiManager.gotoLobby();
        }
    }

    /** 房间状态变化 → 刷新 UI。 */
    private _onRoomState(state: RoomState): void {
        const user = services.auth.getCachedUser();
        const myId = user ? user.openid : '';

        setLabelText(this.node, 'Canvas/Header/RoomId', `房间号：${state.roomId}`);

        for (let i = 0; i < this._seatNodes.length; i++) {
            this._renderSeat(SEAT_PATHS[i], state.seats[i], myId);
        }

        this._isOwner = state.ownerId === myId;

        console.log(
            `[RoomScene] 房间状态更新：roomId=${state.roomId} status=${state.status} 房主=${this._isOwner} isPractice=${state.isPractice} seeds=${JSON.stringify(state.seats.map((s) => `${s.nickname}${s.isAI ? '[AI]' : ''}${s.ready ? '(已准备)' : '(未准备)'}`))}`,
        );

        switch (state.status) {
            case RoomStatus.WAITING:
                this._setStatus('等待玩家入座并准备…');
                break;
            case RoomStatus.READY:
                this._setStatus(this._isOwner ? '全员已准备，点击「开始游戏」' : '等待房主开始游戏…');
                break;
            case RoomStatus.PLAYING:
                this._setStatus('对局进行中');
                break;
            case RoomStatus.FINISHED:
                this._setStatus('对局已结束');
                break;
            case RoomStatus.DISSOLVED:
                this._setStatus('房间已解散');
                uiManager.toast('房间超时解散', undefined);
                break;
            default:
                break;
        }

        this._refreshButtons(state);

        // 满足开局条件 → 直接开局（READY 后自动进入对局）。
        // ⚠️ 判定顺序很重要：练习房（isPractice）与「我 = 房主 + READY」都要放行，
        //    且必须排除已 PLAYING（否则状态推送会重复开局）。
        //
        // ⚠️ 练习房额外要求「全员入座」：以前只要 isPractice=true 就无条件开局，
        //    而 AI 座位是**服务端建房时**才填入的 —— 若建库/推送时序有偏差，
        //    就会对着一个还有空位的房间狂调 startGame，每次都被服务端拒绝
        //    （表现为「进房就报错、无法开局」）。先确认座位齐了再开局，
        //    既不空转也能在 AI 座位就位后的那次推送里正常开局。
        const allSeated = state.seats.every((s) => s.playerId !== '');
        const canAutoStart =
            this._isOwner &&
            state.status !== RoomStatus.PLAYING &&
            state.status !== RoomStatus.FINISHED &&
            state.status !== RoomStatus.DISSOLVED &&
            (state.status === RoomStatus.READY || (state.isPractice && allSeated));
        if (canAutoStart) {
            console.log(
                `[RoomScene] 满足自动开局条件（房主 + status=${state.status} isPractice=${state.isPractice}）→ 触发 _onStart`,
            );
            void this._onStart();
        }

        eventBus.emit(GameEvent.ROOM_STATE_CHANGED, state);
    }

    /** 渲染座位内容（写入静态节点里的 Label）。 */
    private _renderSeat(path: string, seat: SeatInfo | undefined, myId: string): void {
        const namePath = `${path}/SeatName`;
        const statusPath = `${path}/SeatStatus`;
        const scorePath = `${path}/SeatScore`;

        const setColor = (p: string, c: Color): void => {
            const n = findNode(this.node, p);
            const l = n ? n.getComponent(Label) : null;
            if (l) l.color = c;
        };

        if (!seat || seat.playerId === '') {
            setLabelText(this.node, namePath, seat && seat.nickname ? seat.nickname : '等待加入…');
            setColor(namePath, THEME.textDim);
            setLabelText(this.node, statusPath, '空位');
            setColor(statusPath, THEME.textDim);
            setLabelText(this.node, scorePath, '');
            return;
        }

        const isMe = seat.playerId === myId;
        const tag = seat.isAI ? ' [AI]' : isMe ? ' (我)' : '';
        setLabelText(this.node, namePath, `${seat.nickname}${tag}`);
        setColor(namePath, isMe ? THEME.primary : THEME.text);

        if (seat.ready) {
            setLabelText(this.node, statusPath, '✓ 已准备');
            setColor(statusPath, THEME.success);
        } else {
            setLabelText(this.node, statusPath, '未准备');
            setColor(statusPath, THEME.textDim);
        }

        setLabelText(this.node, scorePath, seat.score > 0 ? `得分 ${seat.score}` : '');

        if (isMe) {
            this._myReady = seat.ready;
        }
    }

    /** 刷新按钮文案与可用性。 */
    private _refreshButtons(state: RoomState): void {
        setLabelText(
            this.node,
            'Canvas/BtnBar/BtnReady/BtnReadyLabel',
            this._myReady ? '取消准备' : '准  备',
        );

        // AI 练习：**没有准备环节**，把「准备」按钮藏起来（空间让给「离开」）。
        // 与 _initRoom 的文案、以及服务端「练习房房主免准备」保持一致 ——
        // 三处必须同口径，否则会出现「按钮写准备、服务端却已放行」的困惑。
        this._setReadyButtonVisible(!state.isPractice);

        // 「能不能开局」= 房主 + 非对局中 + 练习房全员入座 / 联机房全员就绪。
        //
        // ⚠️ 旧实现在练习房里只要 isPractice=true 就恒报 canStart=true，
        //    连「有座位空缺」都报 true —— 上一轮排查「AI 练习无法开局」时
        //    这条日志直接把方向带偏（它说可开局，服务端却拒了）。
        //    现在按**座位真实就绪情况**判定，与服务端 startGame 的
        //    allSeated && (ready || isAI || 练习房房主) 保持同一口径。
        //    AI 座位视为就绪（AI 不会自己点准备）；练习房房主免准备。
        const allSeated = state.seats.every((s) => s.playerId !== '');
        const allReady = state.seats.every(
            (s) => s.playerId !== '' && (s.ready || s.isAI || (state.isPractice && s.seatIndex === 0)),
        );
        const canStart =
            this._isOwner &&
            state.status !== RoomStatus.PLAYING &&
            state.status !== RoomStatus.FINISHED &&
            state.status !== RoomStatus.DISSOLVED &&
            (state.isPractice ? allSeated : allReady);

        console.log(
            `[RoomScene] 按钮刷新：房主=${this._isOwner} 可开局=${canStart} 状态=${state.status}` +
                ` 我已准备=${this._myReady} 全员入座=${allSeated} 全员就绪=${allReady} isPractice=${state.isPractice}`,
        );
    }

    /**
     * 显隐「准备」按钮（练习房隐藏）。
     *
     * 隐藏时把「离开」按钮挪到中间：否则左半边留个空洞，看起来像按钮丢了。
     */
    private _setReadyButtonVisible(visible: boolean): void {
        if (this._readyHidden === !visible) {
            return; // 状态未变，避免每帧重排
        }
        this._readyHidden = !visible;

        const ready = findNode(this.node, 'Canvas/BtnBar/BtnReady');
        const leave = findNode(this.node, 'Canvas/BtnBar/BtnLeave');
        if (ready) {
            ready.active = visible;
        }
        if (leave) {
            // 设计态：准备在 x=-163、离开在 x=+163（并列居中）。
            // 只剩离开时移到 x=0 居中。
            leave.setPosition(new Vec3(visible ? 163 : 0, leave.position.y, leave.position.z));
        }
        console.log(`[RoomScene] 准备按钮${visible ? '显示' : '隐藏（AI 练习无准备环节）'}`);
    }

    /** 房间级消息处理。 */
    private _onRoomMessage(cmd: string, payload: unknown): void {
        console.log(`[RoomScene] 收到房间消息 ${cmd}`, payload);
    }

    /** 切换准备状态。 */
    private async _onToggleReady(): Promise<void> {
        try {
            this._myReady = !this._myReady;
            await services.room.setReady(this._myReady);
            setLabelText(
                this.node,
                'Canvas/BtnBar/BtnReady/BtnReadyLabel',
                this._myReady ? '取消准备' : '准  备',
            );
            console.log(`[RoomScene] 准备状态已设置为 ${this._myReady}`);
        } catch (err) {
            console.error('[RoomScene] 设置准备失败:', err);
            uiManager.toast('操作失败，请重试', undefined);
        }
    }

    /** 房主开局。 */
    private async _onStart(): Promise<void> {
        if (this._entered) {
            console.log('[RoomScene] _onStart 跳过（已进入过对局）');
            return;
        }
        // 开局请求进行中：直接跳过。
        //
        // 为什么需要这道闸：room watch 会在每次文档变更时推快照，而真机日志
        // 显示同一个 waiting 快照会被推两次 —— 两次 _onStart 并发时
        // **各自都还在 await 中、_entered 尚未置位**，于是重复调用 startGame
        // （日志里「开局失败」出现两次就是同一原因）。重复调用本身对服务端
        // 是幂等的，但会让错误 toast 弹两次、并放大竞态。
        if (this._starting) {
            console.log('[RoomScene] _onStart 跳过（开局请求进行中）');
            return;
        }
        this._starting = true;
        console.log('[RoomScene] _onStart：调用 startRoom…');
        try {
            await services.room.startRoom();
            console.log('[RoomScene] startRoom 成功，拉取房间快照…');
            const state = await services.room.getRoomState();
            if (state) {
                this._enterGame(state);
            } else {
                console.warn('[RoomScene] getRoomState 返回 null，无法进入对局');
            }
        } catch (err) {
            console.error('[RoomScene] 开局失败:', err);
            uiManager.toast(`${(err as Error).message}`, undefined);
        } finally {
            // 失败后允许重试（例如另一个人刚入座再点开始）；成功路径由
            // _entered 兜住，不会因重进而重复切场景。
            this._starting = false;
        }
    }

    /** 进入对局场景。 */
    private _enterGame(state: RoomState): void {
        if (this._entered) return;
        this._entered = true;

        // ⚠️ 必须在这里停掉 room watch —— 这是「落子无反应 + 卡在对手思考中」的根因
        //    （2026-09-24 真机事故）。
        //
        // 为什么：对局期间云函数每写一次 `rooms.updatedAt`，room watch 就会推一次快照，
        //   而 `_onRoomState` 在 `status=playing` 时仍会跑 `_refreshButtons` ——
        //   于是「每次落子 → room 推送 → 打日志/刷按钮 → …」形成反馈回路。
        //   更糟的是 `gomoku_move` 一次调用会写**两帧**对局文档（人类手 + AI 回手），
        //   每帧都更新 rooms，于是每步落子产生**两次** room 推送 ——
        //   落在 Game 场景里就是持续的无效刷新，把 JS 线程占满，
        //   连 watch 推来的 `gk.move.result` 都来不及处理。
        //   症状恰好是「棋盘不动、遮罩不消失、日志停在进对局那一行」。
        //
        // 进入对局后房间页面不再可见，本就不再需要 room 推送；
        // 之后若要显示对手在线状态，应当用**单独的一条通道 + 真的处理它**，
        // 而不是让一个已经离开的场景继续刷新自己的 UI。
        if (this._unwatch) {
            this._unwatch();
            this._unwatch = null;
            console.log('[RoomScene] 已停止 room watch（进入对局，房间推送不再需要）');
        }

        const params: GameSceneParams = {
            gameId: state.gameId,
            mode: this._params!.mode,
            room: state,
        };
        console.log(`[RoomScene] 进入对局场景（gameId=${state.gameId} mode=${params.mode}）`);
        uiManager.gotoGame(params);
    }

    /** 离开房间。 */
    private async _onLeave(): Promise<void> {
        try {
            await services.room.leaveRoom();
        } catch (err) {
            console.error('[RoomScene] 离开房间失败:', err);
        }
        uiManager.gotoLobby();
    }

    /** 分享房间（经 IShareService，Mock 阶段打印日志）。 */
    private _onShare(): void {
        const params = this._params!;
        const meta = requireGameMeta(params.gameId);
        const roomId = services.room.getCurrentRoomId() ?? params.joinRoomId ?? '';
        services.share.shareRoom({ roomId, gameId: params.gameId, gameName: meta.name });
        uiManager.toast('已唤起分享（Mock 模式仅打印日志）', undefined);
    }

    /** 设置右上角被动转发内容。 */
    private _setupShare(): void {
        const params = this._params!;
        const meta = requireGameMeta(params.gameId);
        const roomId = services.room.getCurrentRoomId() ?? params.joinRoomId ?? '';
        services.share.setPassiveShare({ roomId, gameId: params.gameId, gameName: meta.name });
    }

    private _setStatus(text: string): void {
        setLabelText(this.node, 'Canvas/Status', text);
    }

    /** 供调试：座位数量。 */
    public getSeatCount(): number {
        return this._seatNodes.length;
    }

    /** 保持 hexToColor 导入可用（主题色扩展时使用）。 */
    private static readonly _refs = { h: hexToColor };
}
