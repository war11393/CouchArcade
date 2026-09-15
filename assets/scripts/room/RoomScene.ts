/**
 * Room 场景控制器（房间/座位系统）。
 *
 * 状态机（规格要求）：
 *   WAITING（等待玩家入座）→ READY（全员就位，房主可开局）
 *     → PLAYING（进入对局）→ FINISHED
 *   异常分支：DISSOLVED（超时解散）、断线重连、中途退出
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
 *        ├─ BtnReady           [cc.Button] → BtnReadyLabel
 *        ├─ BtnLeave           [cc.Button] → BtnLeaveLabel
 *        ├─ SceneRoot          [RoomScene]   ← 本脚本
 *        └─ Camera             [cc.Camera]
 */

import { _decorator, Color, Component, Label, Node } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { requireGameMeta } from '../config/GameList';
import { RoomState, RoomStatus, SeatInfo } from '../core/services/IServices';
import { services, ensureServices } from '../core/ServiceLocator';
import { GameEvent, eventBus } from '../core/EventBus';
import { GameSceneParams, RoomSceneParams, uiManager } from '../core/UIManager';
import { THEME, bindClick, findNode, setLabelText, hexToColor } from '../core/UIFactory';

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

    protected async onLoad(): Promise<void> {
        ensureServices();
        this._params = uiManager.consumeRoomParams();
        if (!this._params) {
            console.warn('[RoomScene] 缺少进入参数，返回大厅');
            uiManager.gotoLobby();
            return;
        }

        this._bindNodes();
        await this._initRoom();
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
        bindClick(this.node, 'Canvas/BtnReady', () => void this._onToggleReady());
        bindClick(this.node, 'Canvas/BtnLeave', () => void this._onLeave());

        // 初始文案
        setLabelText(this.node, 'Canvas/SeatTop/SeatName', '等待加入…');
        setLabelText(this.node, 'Canvas/SeatTop/SeatStatus', '空位');
        setLabelText(this.node, 'Canvas/SeatBottom/SeatName', '等待加入…');
        setLabelText(this.node, 'Canvas/SeatBottom/SeatStatus', '空位');
        setLabelText(this.node, 'Canvas/BtnReady/BtnReadyLabel', '准  备');
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
                console.log('[RoomScene] AI 练习模式：跳过等待，准备开局');
                this._setStatus('AI 对手已就位，点击「开始游戏」开局');
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

        // 全员就绪 + 房主 → 直接开局（保持原行为：READY 后自动进入对局）
        if (this._isOwner && (state.status === RoomStatus.READY || state.isPractice)) {
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
            'Canvas/BtnReady/BtnReadyLabel',
            this._myReady ? '取消准备' : '准  备',
        );

        const canStart =
            this._isOwner &&
            (state.status === RoomStatus.READY || state.isPractice) &&
            state.status !== RoomStatus.PLAYING;

        if (AppConfig.LOG_VERBOSE) {
            console.log(
                `[RoomScene] 按钮刷新：房主=${this._isOwner} 可开局=${canStart} 状态=${state.status}`,
            );
        }
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
                'Canvas/BtnReady/BtnReadyLabel',
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
        if (this._entered) return;
        try {
            await services.room.startRoom();
            const state = await services.room.getRoomState();
            if (state) {
                this._enterGame(state);
            }
        } catch (err) {
            console.error('[RoomScene] 开局失败:', err);
            uiManager.toast(`${(err as Error).message}`, undefined);
        }
    }

    /** 进入对局场景。 */
    private _enterGame(state: RoomState): void {
        if (this._entered) return;
        this._entered = true;

        const params: GameSceneParams = {
            gameId: state.gameId,
            mode: this._params!.mode,
            room: state,
        };
        console.log('[RoomScene] 进入对局场景');
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
