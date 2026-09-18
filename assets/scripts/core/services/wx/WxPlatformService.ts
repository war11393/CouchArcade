/**
 * Wx 平台服务 —— 第二阶段真实实现。
 *
 * 目标 API：wx.getSystemInfoSync / wx.getWindowInfo / wx.getDeviceInfo /
 *          wx.vibrateShort / wx.vibrateLong / wx.getLaunchOptionsSync /
 *          wx.onShow / wx.getUpdateManager
 *
 * 契约提醒：getSystemInfo() 与 getLaunchOptions() 在 IPlatformService 中
 * 被定义为**同步**返回（SafeAreaAdapter / LoadingScene 早期即需取值）。
 * 因此这里必须用 *Sync 系列接口，不要改成 Promise。
 */

import { AppConfig } from '../../../config/AppConfig';
import { IPlatformService, LaunchOptions, SystemInfo, UpdateCheckHandlers } from '../IServices';

export class WxPlatformService implements IPlatformService {
    /**
     * 获取系统信息（同步）。
     *
     * 实现策略：优先用官方推荐的 getWindowInfo + getDeviceInfo 组合
     * （getSystemInfoSync 已被标记为不推荐但小游戏端仍可用），
     * 二者任一缺失时回落到 getSystemInfoSync —— 兼容低版本基础库。
     */
    public getSystemInfo(): SystemInfo {
        const base = wx.getSystemInfoSync();

        // ---- 窗口信息（含 safeArea，官方新接口） ----
        let screenWidth = base.screenWidth;
        let screenHeight = base.screenHeight;
        let pixelRatio = base.pixelRatio;
        let statusBarHeight = base.statusBarHeight ?? 0;
        let rawSafeArea = base.safeArea;

        try {
            if (typeof wx.getWindowInfo === 'function') {
                const win = wx.getWindowInfo();
                if (win) {
                    screenWidth = win.screenWidth ?? screenWidth;
                    screenHeight = win.screenHeight ?? screenHeight;
                    pixelRatio = win.pixelRatio ?? pixelRatio;
                    if (typeof win.statusBarHeight === 'number') {
                        statusBarHeight = win.statusBarHeight;
                    }
                    if (win.safeArea) {
                        rawSafeArea = win.safeArea;
                    }
                }
            }
        } catch (err) {
            console.warn('[WxPlatform] getWindowInfo 失败，回落 getSystemInfoSync:', err);
        }

        // ---- 平台标识 ----
        let platform = base.platform;
        try {
            if (typeof wx.getDeviceInfo === 'function') {
                const dev = wx.getDeviceInfo();
                if (dev && dev.platform) {
                    platform = dev.platform;
                }
            }
        } catch (err) {
            console.warn('[WxPlatform] getDeviceInfo 失败，回落 getSystemInfoSync:', err);
        }

        return {
            screenWidth,
            screenHeight,
            pixelRatio,
            platform, // 'ios' | 'android' | 'devtools' | 'windows' | 'mac' ...
            safeArea: this._normalizeSafeArea(rawSafeArea, screenWidth, screenHeight),
            statusBarHeight,
            SDKVersion: base.SDKVersion,
            isMiniGame: true,
        };
    }

    /**
     * 归一化安全区。
     *
     * 防御点：部分低版本基础库 safeArea 缺失，或返回全 0；
     * 直接透传会让 SafeAreaAdapter 算出 0 留白（顶部被刘海遮挡）。
     * 这里在数据不可信时回落到 AppConfig 的兜底值。
     */
    private _normalizeSafeArea(
        raw: WxSystemInfo['safeArea'],
        screenWidth: number,
        screenHeight: number,
    ): SystemInfo['safeArea'] {
        const usable =
            !!raw &&
            Number.isFinite(raw.top) &&
            Number.isFinite(raw.bottom) &&
            Number.isFinite(raw.left) &&
            Number.isFinite(raw.right) &&
            Number.isFinite(raw.width) &&
            Number.isFinite(raw.height) &&
            raw.width > 0 &&
            raw.height > 0;

        if (usable && raw) {
            return {
                top: raw.top,
                bottom: raw.bottom,
                left: raw.left,
                right: raw.right,
                width: raw.width,
                height: raw.height,
            };
        }

        console.warn('[WxPlatform] safeArea 缺失或非法，使用 AppConfig 兜底值');
        const top = AppConfig.SAFE_AREA_FALLBACK_TOP;
        const bottom = AppConfig.SAFE_AREA_FALLBACK_BOTTOM;
        return {
            top,
            bottom,
            left: 0,
            right: screenWidth,
            width: screenWidth,
            height: Math.max(0, screenHeight - top - bottom),
        };
    }

    public vibrateShort(): void {
        try {
            // 注意：调用间隔 < 30ms 会被系统忽略（快速连点不保证每次都振）
            wx.vibrateShort({
                type: 'light',
                fail: (e: unknown) => console.warn('[WxPlatform] vibrateShort 失败:', e),
            });
        } catch (err) {
            // 振动是非关键反馈，失败仅告警
            console.warn('[WxPlatform] vibrateShort 异常:', err);
        }
    }

    public vibrateLong(): void {
        try {
            wx.vibrateLong({
                fail: (e: unknown) => console.warn('[WxPlatform] vibrateLong 失败:', e),
            });
        } catch (err) {
            console.warn('[WxPlatform] vibrateLong 异常:', err);
        }
    }

    /**
     * 获取启动参数（同步）。
     *
     * 注意：query 中的值**全部是字符串**（如 roomId 是 '123456' 而非数字），
     * 调用方需按字符串处理。
     *
     * 重要：本接口只覆盖**冷启动**。App 已在后台时从分享卡片再次进入
     * 不会更新这里的返回值 —— 该场景必须由调用方注册 wx.onShow 处理
     * （见 subscribeShow）。
     */
    public getLaunchOptions(): LaunchOptions {
        const raw = wx.getLaunchOptionsSync();
        return {
            scene: raw.scene,
            query: raw.query ?? {},
            shareTicket: raw.shareTicket,
            referrerInfo: raw.referrerInfo,
        };
    }

    /**
     * 订阅「热启动」回调（从后台切回前台 / 点击新分享卡片）。
     *
     * 这是本项目最容易漏做的一环：wx.getLaunchOptionsSync 不会更新，
     * 必须靠 onShow 才能拿到新的 query（如从另一张卡片进房）。
     *
     * @returns 取消订阅函数
     */
    public subscribeShow(cb: (options: LaunchOptions) => void): () => void {
        const handler = (res: WxLaunchOptions): void => {
            cb({
                scene: res.scene,
                query: res.query ?? {},
                shareTicket: res.shareTicket,
                referrerInfo: res.referrerInfo,
            });
        };
        try {
            wx.onShow(handler);
        } catch (err) {
            console.warn('[WxPlatform] onShow 注册失败:', err);
            return () => undefined;
        }
        return () => {
            try {
                if (typeof wx.offShow === 'function') {
                    wx.offShow(handler);
                }
            } catch (err) {
                console.warn('[WxPlatform] offShow 失败:', err);
            }
        };
    }

    /**
     * 检查版本更新。
     *
     * 微信约束：
     *   · 小游戏**不支持强制更新**，applyUpdate 必须由用户在弹窗确认后触发；
     *   · 首次上传的版本不会触发更新流程（属正常现象）；
     *   · 需在启动早期注册，越早越能覆盖「热启动拿到新版本」的情况。
     */
    public checkUpdate(handlers: UpdateCheckHandlers): void {
        if (typeof wx.getUpdateManager !== 'function') {
            console.warn('[WxPlatform] 当前环境无 getUpdateManager，跳过版本检查');
            return;
        }

        try {
            const um = wx.getUpdateManager();

            um.onCheckForUpdate((res) => {
                console.log(`[WxPlatform] 版本检查完成 hasUpdate=${res.hasUpdate}`);
                if (res.hasUpdate) {
                    handlers.onHasUpdate?.();
                }
            });

            um.onUpdateReady(() => {
                console.log('[WxPlatform] 新版本已下载完成，等待用户确认重启');
                // 把 apply 交给上层：由 UI 弹窗询问后再调用
                handlers.onUpdateReady?.(() => {
                    try {
                        um.applyUpdate();
                    } catch (err) {
                        console.error('[WxPlatform] applyUpdate 失败:', err);
                    }
                });
            });

            um.onUpdateFailed(() => {
                console.warn('[WxPlatform] 新版本下载失败，继续使用当前版本');
                handlers.onUpdateFailed?.();
            });
        } catch (err) {
            console.error('[WxPlatform] getUpdateManager 初始化失败:', err);
        }
    }
}
