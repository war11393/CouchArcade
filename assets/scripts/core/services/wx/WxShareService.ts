/**
 * Wx 分享服务桩 —— 第二阶段联通实现。
 * 目标 API：wx.shareAppMessage / wx.onShareAppMessage / wx.showShareMenu / wx.onShareMessageToFriend
 */

import { IShareService, ShareResult, ShareRoomInfo } from '../IServices';

export class WxShareService implements IShareService {
    public shareRoom(roomInfo: ShareRoomInfo): void {
        // TODO(wechat-phase2): 主动拉起分享
        //   wx.shareAppMessage({
        //       title: `快来和我玩「${roomInfo.gameName}」！房间号 ${roomInfo.roomId}`,
        //       imageUrl: '',                       // 建议 5:4 图片，第二阶段补美术资源
        //       query: `roomId=${roomInfo.roomId}&gameId=${roomInfo.gameId}`,
        //   });
        //   注意：query 长度上限 1024 字符；分享图片建议 ≤ 300KB（大图会导致分享失败）。
        //   验证方法：真机点击「邀请好友」，弹出分享面板，好友点击卡片可直进房间。
    }

    public onShareResult(cb: (result: ShareResult) => void): () => void {
        // TODO(wechat-phase2): 订阅分享结果
        //   wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
        //   wx.onShareAppMessage(() => ({ title, query }));   // 被动转发（右上角菜单）
        //   注意：主动 shareAppMessage 的 success 回调仅代表「面板已拉起」，
        //   不代表用户真的分享成功；如需准确结果，依赖 onShareMessageToFriend
        //   或分享卡片被点击后的启动 query（scene=1044 群聊卡片）。
        //   验证方法：真机分享后回调被触发，且无异常日志。
        return () => {
            // TODO(wechat-phase2): 取消订阅（wx.offShareAppMessage 等）
        };
    }

    public setPassiveShare(roomInfo: ShareRoomInfo): void {
        // TODO(wechat-phase2): 设置右上角菜单转发内容
        //   wx.onShareAppMessage(() => ({
        //       title: `快来和我玩「${roomInfo.gameName}」！房间号 ${roomInfo.roomId}`,
        //       query: `roomId=${roomInfo.roomId}&gameId=${roomInfo.gameId}`,
        //   }));
        //   并在进入房间时调用 wx.showShareMenu({ withShareTicket: true })。
        //   验证方法：真机在房间内点右上角「转发」，卡片带正确房间号。
    }
}
