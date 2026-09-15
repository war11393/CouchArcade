/**
 * Mock 网络同步服务 —— 第一阶段最核心的实现。
 *
 * 核心设计（规格 3. Mock 行为约定）：
 *   「Mock 联机 = 通过同步协议通道与 AI 对打」
 *
 * 具体做法：
 * 1. 客户端 send(cmd, payload) 不会直接改动棋局，而是把上行报文交给「权威裁判」
 *    (IMockAuthority，由 MockRoomService 在开局时装配)；
 * 2. 权威裁判按规则算出结果（含 80~200ms 模拟网络延迟）；
 * 3. 结果被封装成与真实服务器完全一致的下行 NetMessage，经 onMessage 回调回传；
 * 4. 轮到对手时，同一权威裁判内部调用对应游戏的 AI 决策，把 AI 的操作
 *    也封装成一模一样的下行消息回传 —— 业务层无法区分「真人」与「AI」。
 *
 * 因此第二阶段把本文件替换为 WxNetSyncService（走云函数/实时数据推送）时，
 * 业务层的收发代码与协议解析逻辑零改动。
 */

import { AppConfig } from '../../../config/AppConfig';
import { makeEnvelope, ProtocolEnvelope } from '../../../core/protocol/Protocol';
import { INetSyncService, NetMessage, NetMessageHandler, NetStatus } from '../IServices';

/**
 * 权威裁判接口：由具体游戏的房间/规则层实现，负责判定一条上行请求的结果。
 *
 * @returns 需要下发的下行报文数组（可能多条：如翻中机头会带额外回合 + 状态同步）
 */
export interface IMockAuthority {
    /** 接收到一条上行消息，返回需要广播的下行消息（不含发送者本地回显） */
    handleUpstream(msg: NetMessage): NetMessage[];
    /** 是否轮到 AI 行动；若是，返回 AI 生成的下行消息 */
    pollAiAction(): NetMessage[];
    /** 连接建立时的初始化（下发首手、布局等） */
    onConnect(): NetMessage[];
    /** 断线重连后的全量状态补偿 */
    onResync(): NetMessage[];
}

export class MockNetSyncService implements INetSyncService {
    private readonly _msgHandlers: NetMessageHandler[] = [];
    private readonly _statusHandlers: Array<(s: NetStatus) => void> = [];
    private _status: NetStatus = NetStatus.DISCONNECTED;
    private _roomId = '';
    private _playerId = '';
    private _authority: IMockAuthority | null = null;
    private _opponentPlayerId = '';
    private _statusPollTimer: ReturnType<typeof setInterval> | null = null;
    private _aiPollTimer: ReturnType<typeof setInterval> | null = null;
    private _pendingCount = 0;

    // ==================== 对外接口实现 ====================

    public async connect(roomId: string): Promise<void> {
        this._roomId = roomId;
        this._setStatus(NetStatus.CONNECTING);
        console.log(`[MockNetSync] 正在连接房间 ${roomId} ...`);

        // 模拟握手往返
        await this._delay(this._rand(AppConfig.MOCK_LATENCY_MIN_MS, AppConfig.MOCK_LATENCY_MAX_MS));

        this._setStatus(NetStatus.CONNECTED);
        console.log(`[MockNetSync] 已连接房间 ${roomId}（Mock 协议通道，对手由 AI 驱动）`);

        // 连接建立后由权威方决定是否立即下发首手/布局
        this._flush(this._authority ? this._authority.onConnect() : []);

        // 轮询 AI 行动：Mock 阶段用轮询而非事件驱动，
        // 是为了让「AI 何时出手」由权威裁判的回合状态决定，与真实服务器推送等价。
        this._startAiPolling();
    }

    /**
     * 发送上行报文。
     *
     * 关键：这里不直接改棋局，而是交给权威裁判判定后异步回传下行结果，
     * 因此业务层必须「等下行消息」再刷新 UI，天然符合服务器权威模型。
     */
    public send(cmd: string, payload: unknown): void {
        if (this._status !== NetStatus.CONNECTED) {
            console.warn(`[MockNetSync] 未连接，忽略发送: ${cmd}`);
            return;
        }

        const msg: NetMessage = makeEnvelope(cmd, this._roomId, this._playerId, payload);
        this._pendingCount++;

        if (AppConfig.LOG_VERBOSE) {
            console.log(`[MockNetSync] ↑ 上行 ${cmd}`, payload);
        }

        // 模拟网络延迟后交给权威裁判
        const latency = this._rand(AppConfig.MOCK_LATENCY_MIN_MS, AppConfig.MOCK_LATENCY_MAX_MS);
        setTimeout(() => {
            this._pendingCount--;
            if (!this._authority) {
                // 无权威（如纯 AI 练习模式下未装配）时不回传，避免卡死
                console.warn(`[MockNetSync] 无权威裁判，${cmd} 被丢弃`);
                return;
            }
            const downstream = this._authority.handleUpstream(msg);
            this._flush(downstream);
        }, latency);
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
        this._stopPolling();
        this._authority = null;
        this._opponentPlayerId = '';
        this._setStatus(NetStatus.DISCONNECTED);
        console.log('[MockNetSync] 已断开');
    }

    public async reconnect(): Promise<void> {
        if (!this._roomId) {
            console.warn('[MockNetSync] 无房间上下文，无法重连');
            return;
        }
        this._setStatus(NetStatus.RECONNECTING);
        console.log('[MockNetSync] 重连中（模拟切后台回前台）...');
        await this._delay(this._rand(400, 900));
        this._setStatus(NetStatus.CONNECTED);
        // 重连成功后补发全量状态，验证「断线重连」数据补偿逻辑
        this._flush(this._authority ? this._authority.onResync() : []);
        this._startAiPolling();
        console.log('[MockNetSync] 重连完成，已请求全量状态补偿');
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

    // ==================== Mock 专用接口（供 RoomService 装配） ====================

    /** 设置本机 playerId（登录后由 RoomService 注入）。 */
    public setPlayerId(playerId: string): void {
        this._playerId = playerId;
    }

    /** 装配权威裁判（对局开始时由具体游戏模块注入自身规则层）。 */
    public setAuthority(authority: IMockAuthority | null): void {
        this._authority = authority;
    }

    /** 绑定对手 playerId（用于区分上下行归属）。 */
    public bindOpponent(roomId: string, opponentPlayerId: string): void {
        this._roomId = roomId;
        this._opponentPlayerId = opponentPlayerId;
        console.log(`[MockNetSync] 已绑定 Mock 对手: ${opponentPlayerId}`);
    }

    public unbindOpponent(): void {
        this._opponentPlayerId = '';
        this._authority = null;
    }

    /** 当前绑定的对手 id（空表示无对手）。 */
    public getOpponentId(): string {
        return this._opponentPlayerId;
    }

    // ==================== 内部实现 ====================

    /**
     * 下发一批下行消息。
     * 每条消息同样经过 80~200ms 延迟，模拟真实网络时序，
     * 保证「AI 出手 → UI 响应」的节奏与真实联机一致。
     */
    private _flush(messages: NetMessage[]): void {
        if (!messages || messages.length === 0) {
            return;
        }
        for (const msg of messages) {
            const latency = this._rand(AppConfig.MOCK_LATENCY_MIN_MS, AppConfig.MOCK_LATENCY_MAX_MS);
            setTimeout(() => {
                if (this._status !== NetStatus.CONNECTED) {
                    return;
                }
                if (AppConfig.LOG_VERBOSE) {
                    console.log(`[MockNetSync] ↓ 下行 ${msg.cmd}`, msg.payload);
                }
                for (const cb of this._msgHandlers.slice()) {
                    try {
                        cb(msg);
                    } catch (err) {
                        console.error(`[MockNetSync] 消息处理异常 ${msg.cmd}:`, err);
                    }
                }
            }, latency);
        }
    }

    /**
     * 轮询 AI 行动。
     *
     * 为什么用轮询：AI 何时能行动取决于「是否轮到它且它还没动手」，
     * 这个判断属于权威裁判的职责。轮询把该判断权完全交给权威，
     * 使 Mock 的行为与「服务器在轮到对手时主动 push」在语义上等价。
     */
    private _startAiPolling(): void {
        this._stopPolling();
        this._aiPollTimer = setInterval(() => {
            if (this._status !== NetStatus.CONNECTED || !this._authority) {
                return;
            }
            const actions = this._authority.pollAiAction();
            this._flush(actions);
        }, 200);
    }

    private _stopPolling(): void {
        if (this._aiPollTimer !== null) {
            clearInterval(this._aiPollTimer);
            this._aiPollTimer = null;
        }
        if (this._statusPollTimer !== null) {
            clearInterval(this._statusPollTimer);
            this._statusPollTimer = null;
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
                console.error('[MockNetSync] 状态回调异常:', err);
            }
        }
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private _rand(min: number, max: number): number {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    /** 供测试/调试：是否存在未完成的上行请求。 */
    public hasPending(): boolean {
        return this._pendingCount > 0;
    }

    /** 供测试/调试：当前权威裁判（可能为 null）。 */
    public getAuthority(): IMockAuthority | null {
        return this._authority;
    }

    /** 供调试：直接注入一条下行消息（模拟服务器主动推送）。 */
    public injectDownstream(envelope: ProtocolEnvelope): void {
        this._flush([envelope as NetMessage]);
    }
}
