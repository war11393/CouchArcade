/**
 * Mock 平台服务：编辑器预览/浏览器环境下提供系统信息、振动、启动参数。
 *
 * 浏览器没有安全区概念，这里根据窗口宽高比模拟「刘海屏」，
 * 以便在编辑器预览中真实检验 SafeAreaAdapter 的适配逻辑。
 */

import { AppConfig } from '../../../config/AppConfig';
import { IPlatformService, LaunchOptions, SystemInfo } from '../IServices';

export class MockPlatformService implements IPlatformService {
    private _info: SystemInfo | null = null;

    public getSystemInfo(): SystemInfo {
        if (this._info) {
            return this._info;
        }

        // 浏览器环境取窗口尺寸；非浏览器（单元测试）用设计分辨率兜底
        const hasWindow = typeof window !== 'undefined' && !!window.innerWidth;
        const screenWidth = hasWindow ? Math.round(window.innerWidth) : AppConfig.DESIGN_WIDTH;
        const screenHeight = hasWindow ? Math.round(window.innerHeight) : AppConfig.DESIGN_HEIGHT;
        const pixelRatio = hasWindow && window.devicePixelRatio ? window.devicePixelRatio : 2;

        // 竖屏高宽比 ≥ 1.9 视为刘海屏机型，模拟顶部 44 / 底部 34 的避让
        const ratio = screenHeight / Math.max(1, screenWidth);
        const isNotch = ratio >= 1.9;
        const top = isNotch ? AppConfig.SAFE_AREA_FALLBACK_TOP : 0;
        const bottom = isNotch ? AppConfig.SAFE_AREA_FALLBACK_BOTTOM : 0;

        const safeArea = {
            top,
            left: 0,
            right: screenWidth,
            bottom: screenHeight - bottom,
            width: screenWidth,
            height: screenHeight - top - bottom,
        };

        this._info = {
            screenWidth,
            screenHeight,
            pixelRatio,
            platform: 'mock',
            safeArea,
            statusBarHeight: top,
            SDKVersion: 'mock-1.0.0',
            isMiniGame: false,
        };

        console.log(
            `[MockPlatform] 系统信息: ${screenWidth}x${screenHeight} @${pixelRatio}x, ` +
                `安全区 top=${top} bottom=${bottom} (刘海模拟=${isNotch})`,
        );
        return this._info;
    }

    public vibrateShort(): void {
        // 浏览器无振动 API 时静默忽略；有则用 navigator.vibrate 做真实反馈
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(15);
        }
        if (AppConfig.LOG_VERBOSE) {
            console.log('[MockPlatform] vibrateShort()');
        }
    }

    public vibrateLong(): void {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(400);
        }
        if (AppConfig.LOG_VERBOSE) {
            console.log('[MockPlatform] vibrateLong()');
        }
    }

    public getLaunchOptions(): LaunchOptions {
        // 从 URL query 解析 roomId，模拟「分享卡片直进房间」的真实链路：
        // 编辑器中可用 http://localhost:7456/?roomId=123456 直接触发。
        const query: Record<string, string> = {};
        if (typeof window !== 'undefined' && window.location && window.location.search) {
            const params = new URLSearchParams(window.location.search);
            params.forEach((value, key) => {
                query[key] = value;
            });
        }
        return {
            scene: 1007,
            query,
        };
    }

    /** 窗口尺寸变化时清缓存，让 SafeAreaAdapter 重新读取。 */
    public invalidate(): void {
        this._info = null;
    }

    /**
     * 检查版本更新（Mock 实现）。
     *
     * Mock 阶段不模拟真实更新流程（没有可下载的新包），只打日志。
     * 这样 Loading 页在编辑器预览下也能走完整流程而不报错。
     */
    public checkUpdate(_handlers: {
        onHasUpdate?: () => void;
        onUpdateReady?: (apply: () => void) => void;
        onUpdateFailed?: () => void;
    }): void {
        if (AppConfig.LOG_VERBOSE) {
            console.log('[MockPlatform] checkUpdate() 模拟检查更新：无新版本');
        }
    }

    /**
     * 订阅「热启动」回调（Mock 实现）。
     *
     * 编辑器里没有真实的 onShow 生命周期，因此这里用 window 的
     * focus 事件近似模拟「切回前台」，并重新解析 URL query ——
     * 便于在浏览器里手动验证「后台时从另一张卡片进入」的分支：
     * 改动地址栏的 ?roomId=xxx 后点击页面（触发 focus）即可。
     */
    public subscribeShow(cb: (options: LaunchOptions) => void): () => void {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return () => undefined;
        }
        const handler = (): void => {
            const opts = this.getLaunchOptions();
            if (AppConfig.LOG_VERBOSE) {
                console.log('[MockPlatform] 模拟热启动（focus），query=', opts.query);
            }
            cb(opts);
        };
        window.addEventListener('focus', handler);
        return () => {
            window.removeEventListener('focus', handler);
        };
    }

    /**
     * 订阅「网络恢复」回调（Mock 实现）。
     *
     * Mock 阶段用浏览器 online 事件近似模拟，便于在编辑器里验证重连分支。
     */
    public subscribeNetworkRestore(cb: () => void): () => void {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return () => undefined;
        }
        const handler = (): void => {
            if (AppConfig.LOG_VERBOSE) {
                console.log('[MockPlatform] 模拟网络恢复（online）');
            }
            cb();
        };
        window.addEventListener('online', handler);
        return () => {
            window.removeEventListener('online', handler);
        };
    }
}
