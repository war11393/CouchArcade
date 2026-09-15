/**
 * Wx 平台服务桩 —— 第二阶段联通实现。
 *
 * 本文件所有方法体均为空实现 + TODO(wechat-phase2) 标记。
 * 方法签名与 MockPlatformService 完全一致，保证 AppConfig.USE_MOCK=false 时
 * 可无缝替换。
 *
 * 联通步骤见 docs/WECHAT_INTEGRATION_CHECKLIST.md。
 */

import { LaunchOptions, IPlatformService, SystemInfo } from '../IServices';

export class WxPlatformService implements IPlatformService {
    public getSystemInfo(): SystemInfo {
        // TODO(wechat-phase2): 接入 wx.getSystemInfoSync()
        //   const info = wx.getSystemInfoSync();
        //   safeArea 字段说明：
        //     info.safeArea = { top, left, right, bottom, width, height }
        //     本方法需将其转换为 SystemInfo.safeArea 结构后返回。
        //   注意：wx 返回的 safeArea.top 是「状态栏+刘海」的避让高度，
        //   SafeAreaAdapter 会据此计算上下留白。
        //   验证方法：真机（刘海屏 iPhone）预览，顶部标题不被状态栏遮挡。
        throw new Error('[WxPlatformService] getSystemInfo() 未实现（第二阶段联通）');
    }

    public vibrateShort(): void {
        // TODO(wechat-phase2): 接入 wx.vibrateShort({ type: 'light' })
        //   验证方法：真机点击落子/翻格，有轻微振动反馈。
    }

    public vibrateLong(): void {
        // TODO(wechat-phase2): 接入 wx.vibrateLong()
        //   验证方法：真机对局结算弹窗弹出时有长振动。
    }

    public getLaunchOptions(): LaunchOptions {
        // TODO(wechat-phase2): 接入 wx.getLaunchOptionsSync()
        //   需读取 query.roomId 以支持「分享卡片直进房间」。
        //   验证方法：从好友分享的卡片进入，应直接落在指定房间。
        throw new Error('[WxPlatformService] getLaunchOptions() 未实现（第二阶段联通）');
    }

    /**
     * 检查版本更新（Loading 页调用）。
     *
     * 联通步骤：
     *   1. const um = wx.getUpdateManager();
     *   2. um.onCheckForUpdate(res => res.hasUpdate && handlers.onHasUpdate?.());
     *   3. um.onUpdateReady(() => handlers.onUpdateReady?.(() => um.applyUpdate()));
     *   4. um.onUpdateFailed(() => handlers.onUpdateFailed?.());
     *
     * 注意：
     *   · 小游戏**不支持强制更新**，applyUpdate 由用户在弹窗确认后触发；
     *   · 首次上传的版本不会触发更新流程（属正常现象）；
     *   · 需在启动早期注册，越早越能覆盖「热启动拿到新版本」的场景。
     */
    public checkUpdate(handlers: {
        onHasUpdate?: () => void;
        onUpdateReady?: (apply: () => void) => void;
        onUpdateFailed?: () => void;
    }): void {
        // TODO(wechat-phase2): 接入 wx.getUpdateManager()
        //   const um = wx.getUpdateManager();
        //   um.onCheckForUpdate((res) => { if (res.hasUpdate) handlers.onHasUpdate?.(); });
        //   um.onUpdateReady(() => handlers.onUpdateReady?.(() => um.applyUpdate()));
        //   um.onUpdateFailed(() => handlers.onUpdateFailed?.());
        console.log('[WxPlatformService] checkUpdate() 未实现（第二阶段联通），跳过版本检查');
    }
}
