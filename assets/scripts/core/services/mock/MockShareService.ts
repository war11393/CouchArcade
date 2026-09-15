/**
 * Mock 分享服务：在浏览器中用日志 + 控制台提示模拟分享，
 * 便于第一阶段验证「邀请好友」的完整调用链与回调处理。
 */

import { AppConfig } from '../../../config/AppConfig';
import { IShareService, ShareResult, ShareRoomInfo } from '../IServices';

export class MockShareService implements IShareService {
    private readonly _resultHandlers: Array<(r: ShareResult) => void> = [];
    private _passive: ShareRoomInfo | null = null;

    public shareRoom(roomInfo: ShareRoomInfo): void {
        console.log(
            `[MockShare] 模拟分享房间：${roomInfo.gameName} 房间号 ${roomInfo.roomId}\n` +
                `           分享链接（模拟）：?roomId=${roomInfo.roomId}&gameId=${roomInfo.gameId}`,
        );

        // 模拟分享面板弹出 → 用户 1.2s 后完成分享
        setTimeout(() => {
            this._emit({ success: true });
        }, 1200);
    }

    public onShareResult(cb: (result: ShareResult) => void): () => void {
        this._resultHandlers.push(cb);
        return () => {
            const i = this._resultHandlers.indexOf(cb);
            if (i >= 0) {
                this._resultHandlers.splice(i, 1);
            }
        };
    }

    public setPassiveShare(roomInfo: ShareRoomInfo): void {
        this._passive = roomInfo;
        console.log(`[MockShare] 已设置右上角转发内容：房间 ${roomInfo.roomId}`);
    }

    /** 调试用：当前被动分享内容。 */
    public getPassiveShare(): ShareRoomInfo | null {
        return this._passive;
    }

    private _emit(result: ShareResult): void {
        for (const cb of this._resultHandlers.slice()) {
            try {
                cb(result);
            } catch (err) {
                console.error('[MockShare] 分享结果回调异常:', err);
            }
        }
        if (AppConfig.LOG_VERBOSE) {
            console.log('[MockShare] 分享结果:', result);
        }
    }
}
