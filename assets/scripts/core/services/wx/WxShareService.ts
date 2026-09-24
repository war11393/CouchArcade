/**
 * Wx 分享服务 —— 第二阶段真实实现。
 * 目标 API：wx.shareAppMessage / wx.onShareAppMessage / wx.showShareMenu
 *
 * 关键认知（决定了本文件的设计）：
 *   wx.shareAppMessage 的 success 回调**只代表分享面板已拉起**，
 *   不代表用户真的分享成功 —— 据此发奖励会被轻易刷取。
 *   准确的「分享成功」需依赖 onShareMessageToFriend 或分享卡片被点击后的
 *   启动 query（scene=1044 群聊卡片 + shareTicket）。
 *   因此本类把 success/fail 如实上报为「面板结果」，语义上不等同于分享成功。
 */

import { IShareService, ShareResult, ShareRoomInfo } from '../IServices';

export class WxShareService implements IShareService {
    /** 结果回调订阅者。 */
    private readonly _resultHandlers: Array<(r: ShareResult) => void> = [];
    /** 当前的被动转发内容（右上角菜单用）。 */
    private _passiveInfo: ShareRoomInfo | null = null;
    /** 已注册的 onShareAppMessage 处理器（用于取消订阅）。 */
    private _shareMenuHandler: (() => WxShareAppMessageOption) | null = null;

    public shareRoom(roomInfo: ShareRoomInfo): void {
        const option: WxShareAppMessageOption = {
            // 标题优先用调用方的动态文案（含真实入座人数）；缺省回落到通用邀请语
            title: roomInfo.title || `快来和我玩「${roomInfo.gameName}」！房间号 ${roomInfo.roomId}`,
            // imageUrl 留空时微信自动截取当前画面。
            // 如需自定义，须为 5:4 比例且 ≤300KB（过大或比例错误会导致分享失败）。
            query: this._buildQuery(roomInfo),
        };

        try {
            wx.shareAppMessage({
                ...option,
                success: () => {
                    // 注意：仅表示面板已拉起，不等于分享成功
                    this._emit({ success: true, errMsg: 'share panel opened' });
                },
                fail: (e: unknown) => {
                    const errMsg = (e as { errMsg?: string })?.errMsg ?? String(e);
                    console.warn('[WxShare] shareAppMessage 失败:', errMsg);
                    this._emit({ success: false, errMsg });
                },
            });
        } catch (err) {
            const errMsg = String(err);
            console.error('[WxShare] shareAppMessage 异常:', err);
            this._emit({ success: false, errMsg });
        }
    }

    public onShareResult(cb: (result: ShareResult) => void): () => void {
        this._resultHandlers.push(cb);

        // 首次订阅时注册 onShareMessageToFriend（若基础库支持）：
        // 这是唯一能较准确判定「分享给了好友」的回调。
        if (typeof wx.onShareMessageToFriend === 'function') {
            try {
                wx.onShareMessageToFriend((res) => {
                    this._emit({
                        success: !!res.success,
                        errMsg: res.errMsg ?? (res.success ? 'shared to friend' : 'share to friend failed'),
                    });
                });
            } catch (err) {
                console.warn('[WxShare] onShareMessageToFriend 注册失败:', err);
            }
        }

        return () => {
            const i = this._resultHandlers.indexOf(cb);
            if (i >= 0) {
                this._resultHandlers.splice(i, 1);
            }
        };
    }

    /**
     * 设置「右上角菜单转发」的默认分享内容。
     *
     * 使用约束：showShareMenu 必须在用户点击右上角**之前**调用才生效，
     * 因此本方法应在进入 Room 场景时调用（本项目即如此）。
     */
    public setPassiveShare(roomInfo: ShareRoomInfo): void {
        this._passiveInfo = roomInfo;

        // 注册转发内容（onShareAppMessage 会被右上角「转发」触发）
        if (!this._shareMenuHandler) {
            this._shareMenuHandler = () => this._buildPassiveOption();
            try {
                wx.onShareAppMessage(this._shareMenuHandler);
            } catch (err) {
                console.warn('[WxShare] onShareAppMessage 注册失败:', err);
            }
        }

        // 拉出分享菜单（含群聊 shareTicket，便于后续群排行）
        try {
            wx.showShareMenu({
                withShareTicket: true,
                menus: ['shareAppMessage', 'shareTimeline'],
                fail: (e: unknown) => console.warn('[WxShare] showShareMenu 失败:', e),
            });
        } catch (err) {
            console.warn('[WxShare] showShareMenu 异常:', err);
        }

        console.log(`[WxShare] 已设置被动分享 roomId=${roomInfo.roomId}`);
    }

    /** 清理（离开房间时调用，避免转发到已失效的房间）。 */
    public clearPassiveShare(): void {
        this._passiveInfo = null;
        if (this._shareMenuHandler) {
            try {
                if (typeof wx.offShareAppMessage === 'function') {
                    wx.offShareAppMessage(this._shareMenuHandler);
                }
            } catch (err) {
                console.warn('[WxShare] offShareAppMessage 失败:', err);
            }
            this._shareMenuHandler = null;
        }
        try {
            if (typeof wx.hideShareMenu === 'function') {
                wx.hideShareMenu();
            }
        } catch {
            // 忽略：部分基础库无 hideShareMenu
        }
    }

    // ==================== 内部 ====================

    /** 构造分享 query（长度上限 1024 字符，本项目远低于此）。 */
    private _buildQuery(info: ShareRoomInfo): string {
        return `roomId=${encodeURIComponent(info.roomId)}&gameId=${encodeURIComponent(String(info.gameId))}`;
    }

    /** 构造被动转发的分享内容。 */
    private _buildPassiveOption(): WxShareAppMessageOption {
        const info = this._passiveInfo;
        if (!info) {
            // 不在房间时给一个通用文案（分享游戏本身）
            return {
                title: '沙发派对 —— 和朋友一起下五子棋、找机头',
                query: '',
            };
        }
        return {
            // 与主动邀请同源：也吃自定义 title（setPassiveShare 每次状态推送
            // 都会用最新 roomInfo 重设，因此标题能跟着入座人数变）
            title: info.title || `快来和我玩「${info.gameName}」！房间号 ${info.roomId}`,
            query: this._buildQuery(info),
        };
    }

    private _emit(result: ShareResult): void {
        for (const cb of this._resultHandlers.slice()) {
            try {
                cb(result);
            } catch (err) {
                console.error('[WxShare] 结果回调异常:', err);
            }
        }
    }
}
