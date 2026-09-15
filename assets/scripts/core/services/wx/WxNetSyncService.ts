/**
 * Wx 网络同步服务桩 —— 第二阶段联通实现。
 *
 * 实时通道选型：默认采用「云数据库 watch（实时数据推送）」，
 * 备选方案「云托管 WebSocket」的对比与结论见 docs/REALTIME_CHANNEL_DECISION.md。
 *
 * 本类与 MockNetSyncService 的方法签名、消息信封结构完全一致，
 * 切换后业务层（各游戏的 onSyncMessage）无需任何改动。
 */

import { INetSyncService, NetMessage, NetMessageHandler, NetStatus } from '../IServices';

export class WxNetSyncService implements INetSyncService {
    public async connect(roomId: string): Promise<void> {
        // TODO(wechat-phase2): 建立同步通道
        //
        // 方案 A（本项目默认，实时数据推送）：
        //   1. const db = wx.cloud.database();
        //   2. this._watcher = db.collection(COLLECTIONS.GAMES_GOMOKU /* 按游戏选择 */)
        //          .where({ roomId })
        //          .watch({ onChange: s => this._dispatch(s.docs), onError: ... });
        //   3. 收到 doc 后，把新增的棋步封装成 NetMessage 回调给业务层。
        //
        // 方案 B（WebSocket，云托管）：
        //   const socket = wx.connectSocket({ url: `${AppConfig.REMOTE_SERVER}/ws?roomId=${roomId}` });
        //   socket.onMessage(res => this._dispatch(JSON.parse(res.data)));
        //   socket.onOpen/onClose/onError 需同步维护 NetStatus。
        //
        // 注意：无论哪种方案，都必须实现「消息幂等」——重连后可能收到重复棋步，
        // 业务层已按 turnSeq/reqSeq 去重，服务端也需保证写入幂等。
        // 验证方法：真机两账号对局，A 落子后 B 在 500ms 内看到棋子。
        throw new Error('[WxNetSyncService] connect() 未实现（第二阶段联通）');
    }

    public send(cmd: string, payload: unknown): void {
        // TODO(wechat-phase2): 发送上行消息
        //   推荐：走云函数（服务端权威校验），而不是客户端直接写库。
        //   wx.cloud.callFunction({ name: 'gomoku_move', data: { cmd, payload } });
        //   原因：客户端直写数据库无法防止作弊（改包/改前端即可伪造棋步），
        //   云函数内校验合法性是无外挂的基础保障。
        //   验证方法：真机用非法坐标落子，云函数返回错误码且棋局不变。
    }

    public onMessage(cb: NetMessageHandler): () => void {
        // TODO(wechat-phase2): 注册消息监听（同 Mock 实现，维护监听数组即可）
        throw new Error('[WxNetSyncService] onMessage() 未实现（第二阶段联通）');
    }

    public disconnect(): void {
        // TODO(wechat-phase2): 关闭 watch / socket，清理监听
        //   注意：必须显式 close，否则 watch 连接数累积会触发「超出最大连接数」错误。
    }

    public async reconnect(): Promise<void> {
        // TODO(wechat-phase2): 重连并做全量对账
        //   1. 重新建立 watch/socket；
        //   2. 调用 getRoomState 云函数拉取当前房间全量状态；
        //   3. 与本地棋局 diff，补齐离线期间丢失的棋步（关键，否则棋子会缺）。
        //   触发时机：wx.onShow（切回前台）与 wx.onNetworkStatusChange。
        //   验证方法：对局中断网 5 秒再恢复，棋局与对手完全一致。
        throw new Error('[WxNetSyncService] reconnect() 未实现（第二阶段联通）');
    }

    public getStatus(): NetStatus {
        // TODO(wechat-phase2): 返回真实连接状态（由 socket onOpen/onClose 维护）
        return NetStatus.DISCONNECTED;
    }

    public onStatusChange(cb: (status: NetStatus) => void): () => void {
        // TODO(wechat-phase2): 维护状态监听数组
        return () => {
            // 取消订阅
        };
    }

    public getPlayerId(): string {
        // TODO(wechat-phase2): 由 WxAuthService 登录后注入 openid
        return '';
    }
}
