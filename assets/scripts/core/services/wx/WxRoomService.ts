/**
 * Wx 房间服务 —— 第二阶段真实实现。
 *
 * 设计结论：房间逻辑全部放在云函数（服务端权威），客户端只做「调用 + 监听」。
 * 原因：房间号分配、座位抢占、开局条件判定必须由服务端仲裁，否则多端并发出错。
 *
 * 映射关系（云函数源码见 cloudfunctions/）：
 *   createRoom   → cloudfunctions/createRoom      data: { gameId, practice, aiLevel, nickname, avatarUrl }
 *   joinRoom     → cloudfunctions/joinRoom        data: { roomId, action: 'join' }
 *   leaveRoom    → cloudfunctions/joinRoom        data: { roomId, action: 'leave' }
 *   setReady     → cloudfunctions/ready           data: { roomId, ready }
 *   startRoom    → cloudfunctions/startGame       data: { roomId }
 *   watchRoom    → 云数据库 rooms 集合 watch
 *   getRoomState → cloudfunctions/getRoomState    data: { roomId } → { room, game }
 *
 * 云函数统一返回 { code, success, data }，解包由 WxCloudService.callFunction 完成。
 */

import { AiLevel } from '../../../config/AppConfig';
import { COLLECTIONS, STORAGE_KEYS } from '../../../config/Collections';
import { CloudError, ERR } from '../../../config/CloudErrors';
import { GameId } from '../../../config/GameList';
import {
    IAuthService,
    ICloudService,
    IRoomService,
    IStorageService,
    RoomState,
    SeatInfo,
} from '../IServices';

/** getRoomState 云函数的返回结构。 */
interface RoomStateResult {
    room: RoomState | null;
    game?: unknown;
}

export class WxRoomService implements IRoomService {
    private readonly _cloud: ICloudService;
    private readonly _auth: IAuthService;
    private readonly _storage: IStorageService;

    /** 当前房间号（内存缓存，避免频繁读存储）。 */
    private _roomId: string | null = null;
    /** 当前 watch 的取消函数。 */
    private _unwatch: (() => void) | null = null;

    constructor(cloud: ICloudService, auth: IAuthService, storage: IStorageService) {
        this._cloud = cloud;
        this._auth = auth;
        this._storage = storage;
        // 冷启动恢复：上次所在房间号（用于断线重连提示）
        this._roomId = this._storage.get<string>(STORAGE_KEYS.LAST_ROOM) ?? null;
    }

    public async createRoom(
        gameId: GameId,
        practice: boolean,
        aiLevel: AiLevel,
    ): Promise<RoomState> {
        // AI 练习房：服务端仍会建库（便于统一流程），但种子本地生成、不走 watch 对局同步。
        const user = this._auth.getCachedUser();
        const room = await this._cloud.callFunction<
            {
                gameId: GameId;
                practice: boolean;
                aiLevel: AiLevel;
                nickname?: string;
                avatarUrl?: string;
            },
            RoomState
        >('createRoom', {
            gameId,
            practice,
            aiLevel,
            nickname: user?.nickname,
            avatarUrl: user?.avatarUrl,
        });

        this._rememberRoom(room?.roomId ?? null);
        // ⚠️ 身份纠偏（2026-09-24 真机「座位信息异常」死循环）：
        //   响应里的 ownerId 是云函数用 ctx.openid 写的 —— 服务端权威认定的"我"。
        //   若本地正处于登录降级的 local_* 会话，必须当场升级，
        //   否则后续 GameScene 拿 local id 匹配服务端座位必然失败。
        if (room?.ownerId) {
            this._auth.adoptServerIdentity?.(room.ownerId);
        }
        console.log(`[WxRoom] 建房成功 roomId=${room.roomId} gameId=${room.gameId}`);
        return room;
    }

    public async joinRoom(roomId: string): Promise<RoomState> {
        const user = this._auth.getCachedUser();
        const room = await this._cloud.callFunction<
            { roomId: string; action: 'join'; nickname?: string; avatarUrl?: string },
            RoomState
        >('joinRoom', {
            roomId,
            action: 'join',
            nickname: user?.nickname,
            avatarUrl: user?.avatarUrl,
        });

        this._rememberRoom(room?.roomId ?? roomId);
        console.log(`[WxRoom] 入房成功 roomId=${room.roomId}`);
        return room;
    }

    public async leaveRoom(): Promise<void> {
        const roomId = this._roomId;
        if (!roomId) {
            return;
        }

        // 先停 watch，再通知服务端 —— 顺序很重要：
        // 反过来的话，服务端标记离开触发的 watch 回调会打到已离开的客户端。
        this._stopWatch();

        try {
            await this._cloud.callFunction<{ roomId: string; action: 'leave' }, RoomState>(
                'joinRoom',
                { roomId, action: 'leave' },
            );
            console.log(`[WxRoom] 已离开房间 roomId=${roomId}`);
        } catch (err) {
            // 离开失败不应阻断本地流程（用户已经点退出了），但必须记录
            console.warn('[WxRoom] leaveRoom 云函数调用失败（本地已清理）:', err);
        } finally {
            this._rememberRoom(null);
        }
    }

    public async setReady(ready: boolean): Promise<void> {
        const roomId = this._requireRoomId();
        await this._cloud.callFunction<{ roomId: string; ready: boolean }, RoomState>('ready', {
            roomId,
            ready,
        });
        console.log(`[WxRoom] 准备状态已设置 ready=${ready}`);
    }

    public async startRoom(): Promise<void> {
        const roomId = this._requireRoomId();
        await this._cloud.callFunction<{ roomId: string }, RoomState>('startGame', { roomId });
        console.log('[WxRoom] 开局请求已提交，等待服务端广播');
    }

    /**
     * 订阅房间状态变化。
     *
     * 约束：每客户端最多 5 个 watch，因此本方法会**先停掉上一个** watch，
     * 保证同一时刻只有一个房间 watch 存在。
     */
    public watchRoom(cb: (state: RoomState) => void): () => void {
        const roomId = this._requireRoomId();

        // 关键：先释放旧 watch，避免连接数累积触发「超出最大连接数」
        this._stopWatch();

        this._unwatch = this._cloud.watchCollection<RoomState>(
            COLLECTIONS.ROOMS,
            { roomId },
            (docs) => {
                if (!docs || docs.length === 0) {
                    // 房间被删除/解散：视为解散状态通知上层
                    console.warn(`[WxRoom] watch 收到空结果，房间 ${roomId} 可能已解散`);
                    return;
                }
                try {
                    cb(docs[0]);
                } catch (err) {
                    console.error('[WxRoom] watchRoom 回调异常:', err);
                }
            },
        );

        return () => {
            this._stopWatch();
        };
    }

    /**
     * 主动拉取房间全量状态（断线重连兜底）。
     *
     * 调用时机：wx.onShow（切回前台）、watch 的 onError、进入 Room 场景时。
     * 为什么必要：watch 断线重连后**只推增量**，不拉全量会丢状态。
     */
    public async getRoomState(): Promise<RoomState | null> {
        const roomId = this._roomId;
        if (!roomId) {
            return null;
        }

        try {
            const data = await this._cloud.callFunction<{ roomId: string }, RoomStateResult>(
                'getRoomState',
                { roomId },
            );
            const room = data?.room ?? null;
            if (!room) {
                // 服务端判定房间已不存在/已解散 → 清理本地记录
                console.warn(`[WxRoom] getRoomState 返回空，房间 ${roomId} 已失效`);
                this._rememberRoom(null);
                return null;
            }
            return room;
        } catch (err) {
            if (err instanceof CloudError && err.code === ERR.ROOM_NOT_FOUND) {
                this._rememberRoom(null);
                return null;
            }
            throw err;
        }
    }

    public getCurrentRoomId(): string | null {
        return this._roomId;
    }

    /**
     * 房间级消息（表情/投降）。
     *
     * 说明：本项目当前房间级消息统一走 NetSync 通道（对局内），
     * 此处保留接口以兼容 IRoomService 契约，实现为向 NetSync 的薄封装
     * 会引入循环依赖，故此处仅记录日志；
     * 表情/投降的实际发送见各游戏控制器调用 services.netSync.send。
     */
    public sendRoomMessage(cmd: string, payload: unknown): void {
        console.log(`[WxRoom] sendRoomMessage(${cmd}) 请改用 services.netSync.send 发送`, payload);
    }

    // ==================== 内部 ====================

    /** 记录/清理当前房间号（内存 + 存储双写，供冷启动恢复）。 */
    private _rememberRoom(roomId: string | null): void {
        this._roomId = roomId;
        if (roomId) {
            this._storage.set(STORAGE_KEYS.LAST_ROOM, roomId);
        } else {
            this._storage.remove(STORAGE_KEYS.LAST_ROOM);
        }
    }

    /** 停止当前 watch（幂等）。 */
    private _stopWatch(): void {
        if (this._unwatch) {
            try {
                this._unwatch();
            } catch (err) {
                console.warn('[WxRoom] 取消 watch 异常:', err);
            }
            this._unwatch = null;
        }
    }

    private _requireRoomId(): string {
        if (!this._roomId) {
            throw new CloudError(ERR.INVALID_MOVE, '[WxRoom] 当前不在房间中');
        }
        return this._roomId;
    }

    /** 供调试：当前房间的座位列表。 */
    public static findMySeat(room: RoomState, openid: string): SeatInfo | undefined {
        return room.seats.find((s) => s.playerId === openid);
    }
}
