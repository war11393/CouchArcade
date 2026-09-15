/**
 * Wx 房间服务桩 —— 第二阶段联通实现。
 *
 * 设计结论：房间逻辑全部放在云函数（服务端权威），客户端只做「调用 + 监听」。
 * 原因：房间号分配、座位抢占、开局条件判定必须由服务端仲裁，否则多端并发出错。
 *
 * 映射关系（云函数源码见 cloudfunctions/）：
 *   createRoom → cloudfunctions/createRoom
 *   joinRoom   → cloudfunctions/joinRoom
 *   leaveRoom  → cloudfunctions/joinRoom（action: leave）
 *   setReady   → cloudfunctions/ready
 *   startRoom  → cloudfunctions/startGame
 *   watchRoom  → 云数据库 rooms 集合 watch
 *   getRoomState → cloudfunctions/getRoomState
 */

import { AiLevel } from '../../../config/AppConfig';
import { GameId } from '../../../config/GameList';
import { IRoomService, RoomState } from '../IServices';

export class WxRoomService implements IRoomService {
    public async createRoom(
        gameId: GameId,
        practice: boolean,
        aiLevel: AiLevel,
    ): Promise<RoomState> {
        // TODO(wechat-phase2): 调用云函数建房
        //   const res = await wx.cloud.callFunction({
        //       name: 'createRoom',
        //       data: { gameId, practice, aiLevel },
        //   });
        //   return res.result as RoomState;
        //   服务端职责：生成唯一 6 位房间号（需重试防碰撞）、写入 rooms 集合、
        //              把创建者写入 ownerId 与 seats[0]。
        //   注意：practice=true（AI 练习）建议纯客户端本地进行，不走云函数，
        //         以节省云资源并降低延迟。
        //   验证方法：真机建房返回 6 位房间号，rooms 集合出现该文档。
        throw new Error('[WxRoomService] createRoom() 未实现（第二阶段联通）');
    }

    public async joinRoom(roomId: string): Promise<RoomState> {
        // TODO(wechat-phase2): 调用云函数入房
        //   const res = await wx.cloud.callFunction({ name: 'joinRoom', data: { roomId } });
        //   服务端必须做并发保护：使用事务/原子更新占座，防止两个玩家同抢一个座位。
        //   错误码约定：4001 房间不存在、4002 房间已满、4003 已开局、4004 已解散。
        //   验证方法：真机两账号同时加入同一房间，不会坐到同一座位。
        throw new Error('[WxRoomService] joinRoom() 未实现（第二阶段联通）');
    }

    public async leaveRoom(): Promise<void> {
        // TODO(wechat-phase2): 调用云函数退房
        //   注意：房主退出需在服务端移交房主给下一位玩家；
        //   对局中退出按「判负/托管 AI」处理（与 Mock 行为保持一致）。
        //   验证方法：真机对局中退出，对手界面显示「对方已退出」并判定胜负。
    }

    public async setReady(ready: boolean): Promise<void> {
        // TODO(wechat-phase2): 调用云函数 ready
        //   const res = await wx.cloud.callFunction({ name: 'ready', data: { ready } });
        //   服务端职责：更新 seats[i].ready；若全员 ready 则把 status 置为 'ready'。
        //   验证方法：真机双方准备后，房间状态变为 ready，房主可点开局。
    }

    public async startRoom(): Promise<void> {
        // TODO(wechat-phase2): 调用云函数 startGame
        //   服务端职责（关键，权威性来源）：
        //   1. 校验调用者是房主且 status === 'ready'；
        //   2. 生成随机种子 seed 与权威布局（寻机头），写入 games_planehunt；
        //   3. 把 rooms.status 置为 'playing'；
        //   4. 通过数据库更新通知所有客户端（各端 watch 收到后一起进入对局）。
        //   注意：权威布局必须只存在服务端，客户端通过「翻格请求」逐格查询结果。
        //   验证方法：真机双方同时自动进入对局界面，且首手方一致。
        throw new Error('[WxRoomService] startRoom() 未实现（第二阶段联通）');
    }

    public watchRoom(cb: (state: RoomState) => void): () => void {
        // TODO(wechat-phase2): 监听 rooms 集合
        //   return this._cloud.watchCollection(COLLECTIONS.ROOMS, { roomId }, docs => {
        //       if (docs.length > 0) cb(docs[0] as RoomState);
        //   });
        //   注意：离开房间/进入对局后应及时 close，避免占用 watch 连接配额（最多 5 个）。
        //   验证方法：真机对手准备时，本方界面自动刷新准备状态。
        return () => {
            // TODO(wechat-phase2): 取消 watch
        };
    }

    public async getRoomState(): Promise<RoomState | null> {
        // TODO(wechat-phase2): 断线重连兜底，拉取全量房间状态
        //   const res = await wx.cloud.callFunction({ name: 'getRoomState', data: {} });
        //   调用时机：wx.onShow、watch 的 onError、进入 Room 场景时。
        //   验证方法：真机杀进程重进，能恢复到原房间并显示正确状态。
        throw new Error('[WxRoomService] getRoomState() 未实现（第二阶段联通）');
    }

    public getCurrentRoomId(): string | null {
        // TODO(wechat-phase2): 返回内存中缓存的当前房间号；冷启动时读本地缓存
        //   （STORAGE_KEYS.LAST_ROOM）用于「断线重连」提示。
        return null;
    }

    public sendRoomMessage(cmd: string, payload: unknown): void {
        // TODO(wechat-phase2): 房间级消息（表情/投降）
        //   建议：表情走数据库增删（或用云函数广播），投降必须走云函数以保证权威判定。
        //   验证方法：真机发送表情，对手界面 1 秒内弹出气泡。
    }
}
