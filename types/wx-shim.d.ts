/**
 * 微信小游戏全局 API 的最小类型声明。
 *
 * 背景：本项目第一阶段不引入任何微信侧依赖（无 minigame-api-typings），
 * 第二阶段实现 core/services/wx/* 时需要引用全局 wx 对象。
 * 为避免引入庞大的官方类型包（且其与 Cocos tsconfig 的 lib 设置有冲突），
 * 这里按「实际用到的 API」声明最小子集。
 *
 * 维护约定：
 *   · 只用到这里没声明的 API 时，在此追加，不要用 any 绕过；
 *   · 类型尽量贴近官方文档，返回值标 | undefined 的地方是官方可能不返回。
 *
 * ⚠️ 文件位置（2026-09-25 搬迁）：本文件原在 `.typecheck/wx-shim.d.ts`，
 *    但 `.typecheck/` 整目录被 `.gitignore` 忽略（那里只应放 typecheck.cmd
 *    **自动生成**的 `cc-shim.d.ts`），导致本文件的手写改动**进不了版本库**。
 *    现移到 `types/`（可跟踪），并在 tsconfig.check.json 的 include 里同步。
 *    改本文件后务必重跑 `.\typecheck.cmd` —— 它才是类型的唯一验收口。
 *
 * 注意：本文件只做类型声明（declare），不产生任何运行时代码，
 * 也不违反「业务层禁止直接调用 wx.*」的铁律 —— 铁律约束的是业务层，
 * core/services/wx/* 正是唯一允许碰 wx 的地方。
 */

// ==========================================================================
// 基础
// ==========================================================================

interface WxSystemInfo {
    screenWidth: number;
    screenHeight: number;
    windowWidth?: number;
    windowHeight?: number;
    pixelRatio: number;
    platform: string;
    system?: string;
    brand?: string;
    model?: string;
    /** 微信基础库版本。 */
    SDKVersion: string;
    statusBarHeight?: number;
    /** 安全区；部分低版本基础库缺失。 */
    safeArea?: {
        top: number;
        left: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
}

interface WxLaunchOptions {
    scene: number;
    query: Record<string, string>;
    shareTicket?: string;
    referrerInfo?: {
        appId: string;
        extraData?: Record<string, unknown>;
    };
}

interface WxUpdateManager {
    onCheckForUpdate(cb: (res: { hasUpdate: boolean }) => void): void;
    onUpdateReady(cb: () => void): void;
    onUpdateFailed(cb: () => void): void;
    applyUpdate(): void;
}

/** wx.login 的返回（只用到 code；fail 时只有 errMsg）。 */
interface WxLoginResult {
    code?: string;
    errMsg?: string;
}

interface WxShareAppMessageOption {
    title?: string;
    imageUrl?: string;
    query?: string;
    imageUrlId?: string;
}

/** shareAppMessage 允许带成功/失败回调（调用侧用，不参与转发内容）。 */
interface WxShareAppMessageCallOption extends WxShareAppMessageOption {
    success?: (res: WxShareAppMessageResult) => void;
    fail?: (e: unknown) => void;
    complete?: (res: unknown) => void;
}

interface WxShareAppMessageResult {
    errMsg: string;
}

interface WxOnNetworkStatusChangeResult {
    isConnected: boolean;
    networkType: string;
}

// ==========================================================================
// 云开发
// ==========================================================================

interface WxCloudCallFunctionResult<T = unknown> {
    result: T;
    errMsg?: string;
    requestID?: string;
}

interface WxCloudDocumentSnapshot<T = unknown> {
    docs: T[];
    docChanges?: Array<{ id: string; dataType: string }>;
    type?: string;
}

interface WxCloudWatcher {
    close(): Promise<void> | void;
    onError?(cb: (err: unknown) => void): void;
}

interface WxCloudQuery<T = unknown> {
    where(query: Record<string, unknown>): WxCloudQuery<T>;
    orderBy(field: string, order: 'asc' | 'desc'): WxCloudQuery<T>;
    skip(n: number): WxCloudQuery<T>;
    limit(n: number): WxCloudQuery<T>;
    get(): Promise<{ data: T[] }>;
    watch(options: {
        onChange: (snapshot: WxCloudDocumentSnapshot<T>) => void;
        onError: (err: unknown) => void;
    }): WxCloudWatcher;
}

interface WxCloudCollection<T = unknown> {
    where(query: Record<string, unknown>): WxCloudQuery<T>;
    orderBy(field: string, order: 'asc' | 'desc'): WxCloudQuery<T>;
    limit(n: number): WxCloudQuery<T>;
    get(): Promise<{ data: T[] }>;
    add(options: { data: unknown }): Promise<{ _id: string }>;
    doc(id: string): { update(options: { data: unknown }): Promise<unknown> };
    watch(options: {
        onChange: (snapshot: WxCloudDocumentSnapshot<T>) => void;
        onError: (err: unknown) => void;
    }): WxCloudWatcher;
}

interface WxCloudDatabase {
    collection<T = unknown>(name: string): WxCloudCollection<T>;
    command: Record<string, unknown>;
    serverDate(options?: { offset?: number }): unknown;
}

interface WxCloud {
    init(options?: { env?: string; traceUser?: boolean }): void;
    callFunction<T = unknown>(options: {
        name: string;
        data?: unknown;
        config?: { env?: string };
    }): Promise<WxCloudCallFunctionResult<T>>;
    database(options?: { env?: string }): WxCloudDatabase;
    DYNAMIC_CURRENT_ENV?: string;
}

// ==========================================================================
// 全局 wx
// ==========================================================================

interface WxApi {
    // ---- 系统信息 ----
    getSystemInfoSync(): WxSystemInfo;
    /** 微信官方推荐的新接口（getSystemInfoSync 已不推荐但小游戏端可用）。 */
    getWindowInfo?(): {
        screenWidth: number;
        screenHeight: number;
        windowWidth: number;
        windowHeight: number;
        pixelRatio: number;
        statusBarHeight?: number;
        safeArea?: WxSystemInfo['safeArea'];
    };
    getDeviceInfo?(): { platform: string; system?: string; brand?: string; model?: string };

    // ---- 振动 ----
    vibrateShort(options?: { type?: 'heavy' | 'medium' | 'light'; fail?: (e: unknown) => void }): void;
    vibrateLong(options?: { fail?: (e: unknown) => void }): void;

    // ---- 启动参数 / 生命周期 ----
    getLaunchOptionsSync(): WxLaunchOptions;
    onShow(cb: (res: WxLaunchOptions) => void): void;
    offShow(cb: (res: WxLaunchOptions) => void): void;
    onHide(cb: () => void): void;
    /**
     * ⚠️ 这两个都用可选（`?`）声明：**能力探测是硬要求**。
     * 部分小游戏基础库未实现它们，标成必选会让 `typeof wx.xxx !== 'function'`
     * 这样的探测被 TS 判定为「恒真」而失去意义（也容易误导后来人删掉探测）。
     * 见 WxPlatformService.subscribeNetworkRestore 的说明。
     */
    onNetworkStatusChange?(cb: (res: WxOnNetworkStatusChangeResult) => void): void;
    offNetworkStatusChange?(cb: (res: WxOnNetworkStatusChangeResult) => void): void;
    /** 网络状态查询（回调式；部分基础库缺失，同样需要探测）。 */
    getNetworkType?(options?: {
        success?: (res: WxOnNetworkStatusChangeResult) => void;
        fail?: (e: unknown) => void;
    }): void;

    // ---- 更新 ----
    getUpdateManager(): WxUpdateManager;

    // ---- 分享 ----
    shareAppMessage(options: WxShareAppMessageCallOption): void;
    onShareAppMessage(cb: () => WxShareAppMessageOption): void;
    offShareAppMessage(cb?: () => WxShareAppMessageOption): void;
    showShareMenu(options?: {
        withShareTicket?: boolean;
        menus?: string[];
        fail?: (e: unknown) => void;
    }): void;
    onShareMessageToFriend?(cb: (res: { success: boolean; errMsg?: string }) => void): void;
    hideShareMenu?(options?: { fail?: (e: unknown) => void }): void;

    // ---- 存储 ----
    getStorageSync(key: string): unknown;
    setStorageSync(key: string, data: unknown): void;
    removeStorageSync(key: string): void;
    clearStorageSync(): void;

    // ---- 登录 ----
    /**
     * 取一次性登录 code（用于本地会话 id 派生，见 WxAuthService）。
     *
     * 注意：本项目**不用** code2Session —— 云开发在云函数内直接注入 OPENID，
     * 这是小游戏云开发的标准做法。这里拿 code 只为生成稳定的本地会话标识。
     */
    login(options?: {
        success?: (res: WxLoginResult) => void;
        fail?: (e: unknown) => void;
    }): void;

    // ---- 云开发 ----
    cloud: WxCloud;

    // ---- 其它 ----
    getAccountInfoSync?(): {
        miniProgram?: { appId?: string; envVersion?: string };
    };
}

declare const wx: WxApi;
