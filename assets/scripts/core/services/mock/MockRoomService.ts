/**
 * Mock 房间服务：模拟「对手 1~3 秒后入座并准备」「房主开局广播」。
 *
 * 状态机：
 *   WAITING（等待玩家） → READY（全员就位，房主可开局） → PLAYING → FINISHED
 *                                           ↘ DISSOLVED（超时/主动解散）
 *
 * AI 练习房（practice=true）：跳过等待，直接补满 AI 座位并置为 READY，
 * 保证「AI 练习跳过等待直接进对局」。
 */

import { AiLevel, AppConfig } from '../../../config/AppConfig';
import { GameId, requireGameMeta } from '../../../config/GameList';
import {
    IAuthService,
    ICloudService,
    INetSyncService,
    IRoomService,
    NetMessage,
    RoomState,
    RoomStatus,
    SeatInfo,
    UserInfo,
} from '../IServices';
import { Cmd, makeEnvelope } from '../../../core/protocol/Protocol';
import { MockCloudService } from './MockCloudService';
import { MockNetSyncService } from './MockNetSyncService';

export class MockRoomService implements IRoomService {
    private readonly _auth: IAuthService;
    private readonly _cloud: ICloudService;
    private readonly _net: INetSyncService;

    private _room: RoomState | null = null;
    private readonly _watchers: Array<(s: RoomState) => void> = [];
    private readonly _roomMsgHandlers: Array<(cmd: string, payload: unknown) => void> = [];
    private _dissolveTimer: ReturnType<typeof setTimeout> | null = null;
    private _roomIdSeq = 100000;

    constructor(auth: IAuthService, cloud: ICloudService, net: INetSyncService) {
        this._auth = auth;
        this._cloud = cloud;
        this._net = net;
        this._registerCloudHandlers();
    }

    // ==================== 对外接口实现 ====================

    public async createRoom(gameId: GameId, practice: boolean, aiLevel: AiLevel): Promise<RoomState> {
        const user = await this._requireUser();
        const meta = requireGameMeta(gameId);
        const roomId = this._genRoomId();

        const seats: SeatInfo[] = [];
        // 0 号位 = 房主 = 自己
        seats.push(this._makeSeat(0, user.openid, user.nickname, user.avatarUrl, true, false, aiLevel));
        // 其余座位先占位为空（playerId 为空表示待入座）
        for (let i = 1; i < meta.playerCount; i++) {
            seats.push(this._emptySeat(i));
        }

        this._room = {
            roomId,
            gameId,
            status: RoomStatus.WAITING,
            seats,
            ownerId: user.openid,
            createdAt: Date.now(),
            maxPlayers: meta.playerCount,
            isPractice: practice,
            seed: practice ? this._randomSeed() : 0,
        };

        console.log(
            `[MockRoom] 创建房间 ${roomId}（${meta.name}${practice ? ' / AI 练习' : ' / 联机'}）`,
        );

        if (practice) {
            // AI 练习：直接补满 AI 并置 READY，跳过等待
            this._fillAiSeats(aiLevel);
            this._setStatus(RoomStatus.READY);
            console.log('[MockRoom] AI 练习房：已跳过等待，直接进入准备完成状态');
        } else {
            // 联机：模拟对手 1~3 秒后入座并准备
            this._scheduleOpponentJoin(aiLevel);
            // 房间超时解散
            this._dissolveTimer = setTimeout(() => {
                if (this._room && this._room.status === RoomStatus.WAITING) {
                    console.warn('[MockRoom] 房间超时未开局，自动解散');
                    this._setStatus(RoomStatus.DISSOLVED);
                    this._broadcastRoomMessage(Cmd.ROOM_DISSOLVE, { reason: 'timeout' });
                }
            }, AppConfig.MOCK_ROOM_TIMEOUT_MS);
        }

        this._notifyWatchers();
        return this._room;
    }

    public async joinRoom(roomId: string): Promise<RoomState> {
        const user = await this._requireUser();
        if (!/^\d{6}$/.test(roomId)) {
            throw new Error('房间号必须为 6 位数字');
        }

        // Mock 阶段：自己建房后加入自己的房间会被拒绝
        if (this._room && this._room.roomId === roomId) {
            console.log(`[MockRoom] 已在房间 ${roomId} 中`);
            return this._room;
        }

        // Mock 入房：创建一个「模拟的他人房间」，自己坐 1 号位，房主由 Mock 玩家担任
        const gameId = GameId.GOMOKU;
        const meta = requireGameMeta(gameId);
        const ownerNick = AppConfig.MOCK_OPPONENT_NICKNAMES[0];
        const seats: SeatInfo[] = [
            this._makeSeat(0, 'mock-owner-9999', ownerNick, '', true, false, AiLevel.NORMAL),
            this._makeSeat(1, user.openid, user.nickname, user.avatarUrl, false, false, AiLevel.NORMAL),
        ];

        this._room = {
            roomId,
            gameId,
            status: RoomStatus.WAITING,
            seats: seats.slice(0, meta.playerCount),
            ownerId: 'mock-owner-9999',
            createdAt: Date.now(),
            maxPlayers: meta.playerCount,
            isPractice: false,
            seed: 0,
        };

        console.log(`[MockRoom] 加入房间 ${roomId}（房主：${ownerNick}）`);
        this._notifyWatchers();

        // 房主 1~2 秒后准备；随后自己准备即可开局
        setTimeout(() => {
            if (this._room && this._room.roomId === roomId) {
                const owner = this._room.seats[0];
                owner.ready = true;
                console.log('[MockRoom] 房主已准备');
                this._notifyWatchers();
            }
        }, this._rand(AppConfig.MOCK_OPPONENT_READY_MIN_MS, AppConfig.MOCK_OPPONENT_READY_MAX_MS));

        return this._room;
    }

    public async leaveRoom(): Promise<void> {
        if (!this._room) {
            return;
        }
        const roomId = this._room.roomId;
        console.log(`[MockRoom] 离开房间 ${roomId}`);

        this._clearTimers();
        this._net.disconnect();

        // 通知其他玩家（模拟房间广播）
        this._broadcastRoomMessage(Cmd.ROOM_LEAVE, { playerId: this._myId() });
        this._room = null;
        this._notifyWatchers();
    }

    public async setReady(ready: boolean): Promise<void> {
        const room = this._requireRoom();
        const me = this._findMe(room);
        me.ready = ready;
        console.log(`[MockRoom] 自己${ready ? '已准备' : '取消准备'}`);

        // 全员准备 → 状态机推进到 READY
        this._refreshReadyStatus();
        this._notifyWatchers();
    }

    public async startRoom(): Promise<void> {
        const room = this._requireRoom();
        if (room.ownerId !== this._myId()) {
            throw new Error('只有房主可以开局');
        }
        if (room.status !== RoomStatus.READY) {
            throw new Error('全员准备后才能开局');
        }

        this._clearTimers();
        room.seed = this._randomSeed();
        this._setStatus(RoomStatus.PLAYING);
        console.log(`[MockRoom] 房主开局广播（seed=${room.seed}）`);

        // 广播开局（房间级 + 同步通道级都发，模拟真实服务器的双通道）
        this._broadcastRoomMessage(Cmd.ROOM_START, { seed: room.seed });
        this._broadcastRoomMessage(Cmd.GAME_START, {
            gameId: room.gameId,
            firstPlayerId: room.seats[0].playerId,
            seed: room.seed,
            serverTime: Date.now(),
        });
        this._notifyWatchers();
    }

    public watchRoom(cb: (state: RoomState) => void): () => void {
        this._watchers.push(cb);
        // 立即推送当前快照，符合真实 watch 的行为
        if (this._room) {
            cb(this._room);
        }
        return () => {
            const i = this._watchers.indexOf(cb);
            if (i >= 0) {
                this._watchers.splice(i, 1);
            }
        };
    }

    public async getRoomState(): Promise<RoomState | null> {
        // 模拟断线重连时的状态拉取：经云函数 getRoomState
        if (!this._room) {
            return null;
        }
        await this._cloud.callFunction('getRoomState', { roomId: this._room.roomId });
        console.log('[MockRoom] getRoomState 拉取成功（断线重连兜底）');
        return this._room;
    }

    public getCurrentRoomId(): string | null {
        return this._room ? this._room.roomId : null;
    }

    public sendRoomMessage(cmd: string, payload: unknown): void {
        this._broadcastRoomMessage(cmd, payload);
    }

    // ==================== Mock 专用 / 供游戏模块使用 ====================

    /** 当前房间快照（只读用途）。 */
    public getRoom(): RoomState | null {
        return this._room;
    }

    /** 我方 playerId。 */
    public getMyId(): string {
        return this._myId();
    }

    /** 对手座位（1v1 场景即除自己外的第一个有效座位）。 */
    public getOpponentSeat(): SeatInfo | null {
        if (!this._room) {
            return null;
        }
        const me = this._findMe(this._room);
        return this._room.seats.find((s) => s.playerId !== me.playerId && s.playerId !== '') ?? null;
    }

    /**
     * 更新座位得分（寻机头用）。
     * 由游戏模块在对局中调用，随后通过 watchRoom 同步到 UI。
     */
    public updateScore(playerId: string, score: number): void {
        if (!this._room) {
            return;
        }
        const seat = this._room.seats.find((s) => s.playerId === playerId);
        if (seat) {
            seat.score = score;
            this._notifyWatchers();
        }
    }

    /** 结束对局，状态机推进到 FINISHED。 */
    public finishGame(): void {
        if (this._room) {
            this._setStatus(RoomStatus.FINISHED);
            this._notifyWatchers();
        }
    }

    /**
     * 再来一局（AI 直接重开 / 联机回房间）。
     * 重置座位准备状态与得分，回到 WAITING/READY。
     */
    public restart(resetReady: boolean): void {
        const room = this._requireRoom();
        room.seats.forEach((s) => {
            s.score = 0;
            if (resetReady && !s.isAI) {
                s.ready = false;
            }
        });
        room.seed = this._randomSeed();
        if (room.isPractice) {
            this._setStatus(RoomStatus.READY);
        } else {
            this._setStatus(resetReady ? RoomStatus.WAITING : RoomStatus.READY);
        }
        console.log(`[MockRoom] 再来一局：状态重置为 ${room.status}`);
        this._notifyWatchers();
    }

    /** 订阅房间级自定义消息（表情/投降等）。 */
    public onRoomMessage(cb: (cmd: string, payload: unknown) => void): () => void {
        this._roomMsgHandlers.push(cb);
        return () => {
            const i = this._roomMsgHandlers.indexOf(cb);
            if (i >= 0) {
                this._roomMsgHandlers.splice(i, 1);
            }
        };
    }

    // ==================== 内部实现 ====================

    private _registerCloudHandlers(): void {
        // 把房间操作注册为 Mock 云函数，验证云函数调用链
        const self = this;
        MockCloudService.registerHandler('getRoomState', function () {
            return self._room;
        });
        MockCloudService.registerHandler('createRoom', function (data) {
            return { roomId: self._room ? self._room.roomId : '', ok: true, input: data };
        });
        MockCloudService.registerHandler('joinRoom', function (data) {
            return { ok: true, input: data };
        });
    }

    /** 模拟对手 1~3 秒后入座并准备。 */
    private _scheduleOpponentJoin(aiLevel: AiLevel): void {
        const delay = this._rand(
            AppConfig.MOCK_OPPONENT_JOIN_MIN_MS,
            AppConfig.MOCK_OPPONENT_JOIN_MAX_MS,
        );
        console.log(`[MockRoom] 对手将在约 ${(delay / 1000).toFixed(1)}s 后入座`);

        setTimeout(() => {
            if (!this._room || this._room.status === RoomStatus.DISSOLVED) {
                return;
            }
            this._fillAiSeats(aiLevel);
            this._notifyWatchers();

            // 对手再延迟一小段后自动准备
            setTimeout(() => {
                if (!this._room || this._room.status === RoomStatus.DISSOLVED) {
                    return;
                }
                for (const s of this._room.seats) {
                    if (s.isAI) {
                        s.ready = true;
                    }
                }
                console.log('[MockRoom] Mock 对手已准备');
                this._refreshReadyStatus();
                this._notifyWatchers();
            }, this._rand(AppConfig.MOCK_OPPONENT_READY_MIN_MS, AppConfig.MOCK_OPPONENT_READY_MAX_MS));
        }, delay);
    }

    /** 用 AI 填满空座位。 */
    private _fillAiSeats(aiLevel: AiLevel): void {
        const room = this._requireRoom();
        for (let i = 0; i < room.seats.length; i++) {
            const seat = room.seats[i];
            if (seat.playerId === '' && !seat.isAI) {
                const nick = AppConfig.MOCK_OPPONENT_NICKNAMES[
                    (i - 1) % AppConfig.MOCK_OPPONENT_NICKNAMES.length
                ];
                room.seats[i] = {
                    seatIndex: i,
                    playerId: `mock-ai-${room.roomId}-${i}`,
                    nickname: nick,
                    avatarUrl: '',
                    ready: false,
                    online: true,
                    isOwner: false,
                    isAI: true,
                    aiLevel,
                    score: 0,
                };
            }
        }
    }

    private _refreshReadyStatus(): void {
        const room = this._requireRoom();
        const allReady = room.seats.every((s) => s.playerId !== '' && s.ready);
        if (allReady && room.status === RoomStatus.WAITING) {
            this._setStatus(RoomStatus.READY);
            console.log('[MockRoom] 全员已准备，房主可开局');
        } else if (!allReady && room.status === RoomStatus.READY) {
            // 有人取消准备则回到等待
            this._setStatus(RoomStatus.WAITING);
        }
    }

    private _setStatus(s: RoomStatus): void {
        if (this._room) {
            this._room.status = s;
        }
    }

    private _notifyWatchers(): void {
        if (!this._room) {
            // 房间已销毁，通知监听者（UI 据此返回大厅）
            return;
        }
        const snapshot = this._room;
        for (const cb of this._watchers.slice()) {
            try {
                cb(snapshot);
            } catch (err) {
                console.error('[MockRoom] watch 回调异常:', err);
            }
        }
    }

    private _broadcastRoomMessage(cmd: string, payload: unknown): void {
        const roomId = this._room ? this._room.roomId : '';
        const env = makeEnvelope(cmd, roomId, this._myId(), payload) as NetMessage;
        for (const cb of this._roomMsgHandlers.slice()) {
            try {
                cb(cmd, env.payload);
            } catch (err) {
                console.error('[MockRoom] 房间消息回调异常:', err);
            }
        }
    }

    private _makeSeat(
        index: number,
        playerId: string,
        nickname: string,
        avatarUrl: string,
        isOwner: boolean,
        isAI: boolean,
        aiLevel: AiLevel,
    ): SeatInfo {
        return {
            seatIndex: index,
            playerId,
            nickname,
            avatarUrl,
            ready: false,
            online: true,
            isOwner,
            isAI,
            aiLevel,
            score: 0,
        };
    }

    private _emptySeat(index: number): SeatInfo {
        return {
            seatIndex: index,
            playerId: '',
            nickname: '等待加入…',
            avatarUrl: '',
            ready: false,
            online: false,
            isOwner: false,
            isAI: false,
            aiLevel: AppConfig.DEFAULT_AI_LEVEL,
            score: 0,
        };
    }

    private _findMe(room: RoomState): SeatInfo {
        const id = this._myId();
        const seat = room.seats.find((s) => s.playerId === id);
        if (!seat) {
            throw new Error('[MockRoom] 当前用户不在房间座位中');
        }
        return seat;
    }

    private _myId(): string {
        const u = this._auth.getCachedUser();
        return u ? u.openid : AppConfig.MOCK_USER_OPENID;
    }

    private async _requireUser(): Promise<UserInfo> {
        const cached = this._auth.getCachedUser();
        if (cached) {
            return cached;
        }
        return this._auth.login();
    }

    private _requireRoom(): RoomState {
        if (!this._room) {
            throw new Error('[MockRoom] 当前不在任何房间中');
        }
        return this._room;
    }

    private _genRoomId(): string {
        this._roomIdSeq = 100000 + Math.floor(Math.random() * 899999);
        return String(this._roomIdSeq);
    }

    private _randomSeed(): number {
        return Math.floor(Math.random() * 2147483647);
    }

    private _clearTimers(): void {
        if (this._dissolveTimer !== null) {
            clearTimeout(this._dissolveTimer);
            this._dissolveTimer = null;
        }
    }

    private _rand(min: number, max: number): number {
        return Math.floor(min + Math.random() * (max - min + 1));
    }
}
