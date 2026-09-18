/**
 * 平台抽象层 —— 接口定义集合。
 *
 * 铁律：游戏逻辑/UI/框架代码中禁止直接出现 wx.* / wx.cloud.* 调用，
 * 一切平台能力必须通过本文件定义的接口获取实现（由 ServiceLocator 注入）。
 *
 * 每个接口都有两套实现：
 * - core/services/mock/MockXxx.ts ：编辑器预览可用（本阶段主用）
 * - core/services/wx/WxXxx.ts     ：方法签名完整 + TODO(wechat-phase2) 桩
 */

import { AiLevel } from '../../config/AppConfig';
import { GameId } from '../../config/GameList';

// ==========================================================================
// 通用类型
// ==========================================================================

/** 用户信息（登录结果）。 */
export interface UserInfo {
    openid: string;
    nickname: string;
    avatarUrl: string;
}

/** 系统信息（屏幕尺寸/安全区/平台）。 */
export interface SystemInfo {
    /** 屏幕宽度（逻辑像素） */
    screenWidth: number;
    /** 屏幕高度（逻辑像素） */
    screenHeight: number;
    /** 像素比 */
    pixelRatio: number;
    /** 平台标识：'mock' | 'ios' | 'android' | 'devtools' */
    platform: string;
    /**
     * 安全区（刘海屏/圆角避让），单位与 screenWidth/Height 一致。
     * 微信规范：safeArea.top / bottom / left / right / width / height。
     */
    safeArea: SafeArea;
    /** 状态栏高度 */
    statusBarHeight: number;
    /** 微信基础库版本（Mock 返回模拟值） */
    SDKVersion: string;
    /** 是否小游戏环境 */
    isMiniGame: boolean;
}

export interface SafeArea {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
}

/** 启动参数（场景值 / query）。 */
export interface LaunchOptions {
    /** 场景值，如 1007（单人会话卡片）、1008（群聊会话卡片）、1044（带 shareTicket 的群聊） */
    scene: number;
    /** 启动 query 参数，如 { roomId: '123456' } */
    query: Record<string, string>;
    /** 分享票据（群排行/群唯一标识用） */
    shareTicket?: string;
    /** 转发来源 */
    referrerInfo?: { appId: string; extraData?: Record<string, unknown> };
}

/** 分享结果。 */
export interface ShareResult {
    /** true = 用户完成分享，false = 取消 */
    success: boolean;
    /** 失败/取消原因 */
    errMsg?: string;
}

/** 分享房间所需信息。 */
export interface ShareRoomInfo {
    roomId: string;
    gameId: GameId;
    gameName: string;
}

// ==========================================================================
// 房间 / 同步相关类型
// ==========================================================================

/** 房间生命周期状态机。 */
export enum RoomStatus {
    /** 等待玩家入座 */
    WAITING = 'waiting',
    /** 全员就位，等待房主开局 */
    READY = 'ready',
    /** 对局进行中 */
    PLAYING = 'playing',
    /** 已结算 */
    FINISHED = 'finished',
    /** 超时/主动解散 */
    DISSOLVED = 'dissolved',
}

/** 座位信息。 */
export interface SeatInfo {
    /** 座位号，0 起；0 号为房主 */
    seatIndex: number;
    playerId: string;
    nickname: string;
    avatarUrl: string;
    /** 是否已准备 */
    ready: boolean;
    /** 是否在线（断线重连用） */
    online: boolean;
    /** 是否房主 */
    isOwner: boolean;
    /** true = AI 托管的虚拟玩家（AI 练习/Mock 对手） */
    isAI: boolean;
    /** AI 难度，仅 isAI 有效 */
    aiLevel: AiLevel;
    /** 累计得分（寻机头用） */
    score: number;
}

/** 房间完整状态快照（watchRoom/getRoomState 返回）。 */
export interface RoomState {
    roomId: string;
    gameId: GameId;
    status: RoomStatus;
    /** 按座位号排序的座位列表（长度 = 游戏所需人数） */
    seats: SeatInfo[];
    /** 房主 playerId */
    ownerId: string;
    /** 房间创建时间戳 */
    createdAt: number;
    /** 房间人数上限（= GameMeta.playerCount） */
    maxPlayers: number;
    /** 是否 AI 练习房（跳过等待） */
    isPractice: boolean;
    /** 对局随机种子（服务端下发，保证双端一致；AI 练习本地生成） */
    seed: number;
}

/** 同步协议消息（联机与 Mock 完全同构）。 */
export interface NetMessage<T = unknown> {
    cmd: string;
    roomId: string;
    playerId: string;
    payload: T;
    timestamp: number;
}

/** 同步消息回调。 */
export type NetMessageHandler = (msg: NetMessage) => void;

/** 连接状态。 */
export enum NetStatus {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    RECONNECTING = 'reconnecting',
}

// ==========================================================================
// 接口定义
// ==========================================================================

/**
 * 版本更新检查回调（对应 wx.getUpdateManager）。
 *
 * 微信约束：小游戏**不支持强制更新**，必须由用户确认后调用 apply。
 */
export interface UpdateCheckHandlers {
    /** 检测到有新版本（正在后台下载）。 */
    onHasUpdate?: () => void;
    /** 新版本下载完成，参数为「重启并应用更新」的函数（需用户确认后调用）。 */
    onUpdateReady?: (apply: () => void) => void;
    /** 更新失败（可继续用旧版本游戏）。 */
    onUpdateFailed?: () => void;
}

/**
 * 平台基础服务：系统信息 / 振动 / 启动参数 / 版本更新。
 * 目标 wx API：wx.getSystemInfoSync、wx.vibrateShort、wx.getLaunchOptionsSync、
 *              wx.getUpdateManager
 */
export interface IPlatformService {
    /** 获取系统信息（屏幕尺寸、安全区、平台）。SafeAreaAdapter 依赖此接口。 */
    getSystemInfo(): SystemInfo;
    /** 短振动（按钮点击/落子/翻格反馈）。 */
    vibrateShort(): void;
    /** 长振动（结算/警告）。 */
    vibrateLong(): void;
    /** 获取启动参数（房间号直进、分享来源）。 */
    getLaunchOptions(): LaunchOptions;
    /**
     * 检查版本更新（Loading 页调用）。
     *
     * 可选实现：未实现时 Loading 页只打日志跳过，不阻断启动流程。
     */
    checkUpdate?(handlers: UpdateCheckHandlers): void;
    /**
     * 订阅「热启动」回调（App 从后台切回前台 / 点击新的分享卡片）。
     *
     * **必需实现的补充路径**：`getLaunchOptions()` 只能拿到**冷启动**参数，
     * App 已在后台时从另一张分享卡片进入不会更新它 ——
     * 这是分享直达房间最常见的线上问题（用户以为点了卡片，却停在大厅）。
     *
     * 可选实现：未实现时业务层只依赖冷启动参数。
     *
     * @returns 取消订阅函数
     */
    subscribeShow?(cb: (options: LaunchOptions) => void): () => void;
    /**
     * 订阅「网络恢复」回调（断网后重新联网）。
     *
     * 用于触发对局断线重连（配合 INetSyncService.reconnect 做全量对账）。
     * 可选实现：未实现时只依赖 subscribeShow 的切前台时机。
     *
     * @returns 取消订阅函数
     */
    subscribeNetworkRestore?(cb: () => void): () => void;
}

/**
 * 登录鉴权服务。
 * 目标 wx API：wx.login + 云函数 login（换取 openid）
 */
export interface IAuthService {
    /**
     * 静默登录，返回用户信息。
     * Mock：直接返回固定测试用户；Wx：wx.login 拿 code → 云函数 login 换 openid。
     */
    login(): Promise<UserInfo>;
    /** 已登录用户缓存（未登录为 null）。 */
    getCachedUser(): UserInfo | null;
    /** 更新昵称/头像（第二阶段走 wx.getUserProfile）。 */
    updateProfile(nickname: string, avatarUrl: string): Promise<UserInfo>;
}

/**
 * 房间服务：建房 / 入房 / 准备 / 开局 / 观战。
 * 目标 wx API：云数据库 rooms 集合 + 云函数 createRoom/joinRoom/ready/startGame/getRoomState
 */
export interface IRoomService {
    /** 创建房间（创建者坐 0 号位，自动成为房主）。 */
    createRoom(gameId: GameId, practice: boolean, aiLevel: AiLevel): Promise<RoomState>;
    /** 按房间号加入房间（6 位数字）。 */
    joinRoom(roomId: string): Promise<RoomState>;
    /** 离开房间；房主离开则移交或解散。 */
    leaveRoom(): Promise<void>;
    /** 设置自己的准备状态。 */
    setReady(ready: boolean): Promise<void>;
    /** 房主开局：广播 GAME_START 并进入对局。 */
    startRoom(): Promise<void>;
    /**
     * 订阅房间状态变化（含成员进出、准备、开局、解散、断线重连）。
     * 返回取消订阅函数。
     */
    watchRoom(cb: (state: RoomState) => void): () => void;
    /** 主动拉取房间状态（断线重连时使用；watch 丢失后的兜底）。 */
    getRoomState(): Promise<RoomState | null>;
    /** 当前所在房间号（不在房间为 null）。 */
    getCurrentRoomId(): string | null;
    /**
     * 向房间内其他玩家广播一条自定义协议消息（表情/投降等房间级消息）。
     * 对局内的棋步请走 INetSyncService.send。
     */
    sendRoomMessage(cmd: string, payload: unknown): void;
}

/**
 * 网络同步服务（对局内棋步/翻格的权威通道）。
 * 目标 wx API：云数据库 watch（实时数据推送）；若选型 WebSocket 则用 wx.connectSocket
 */
export interface INetSyncService {
    /** 连接指定房间的同步通道。 */
    connect(roomId: string): Promise<void>;
    /** 发送协议消息；Mock 会注入 80~200ms 延迟。 */
    send(cmd: string, payload: unknown): void;
    /** 订阅下行消息，返回取消订阅函数。 */
    onMessage(cb: NetMessageHandler): () => void;
    /** 主动断开。 */
    disconnect(): void;
    /** 重连（断线重连/切后台回前台）。 */
    reconnect(): Promise<void>;
    /** 当前连接状态。 */
    getStatus(): NetStatus;
    /** 订阅连接状态变化，返回取消订阅函数。 */
    onStatusChange(cb: (status: NetStatus) => void): () => void;
    /** 本机 playerId（消息构造用）。 */
    getPlayerId(): string;
}

/**
 * 分享服务。
 * 目标 wx API：wx.shareAppMessage、wx.onShareAppMessage、wx.showShareMenu
 */
export interface IShareService {
    /** 分享房间邀请（带 roomId query，好友点击可直进房间）。 */
    shareRoom(roomInfo: ShareRoomInfo): void;
    /** 订阅分享结果回调，返回取消订阅函数。 */
    onShareResult(cb: (result: ShareResult) => void): () => void;
    /** 设置「右上角菜单转发」的默认分享内容。 */
    setPassiveShare(roomInfo: ShareRoomInfo): void;
}

/**
 * 本地存储服务。
 * 目标 wx API：wx.setStorageSync / wx.getStorageSync / wx.removeStorageSync
 * 浏览器兜底：localStorage（Mock 实现）
 */
export interface IStorageService {
    get<T>(key: string, defaultValue?: T): T | undefined;
    set<T>(key: string, value: T): void;
    remove(key: string): void;
    clear(): void;
}

/**
 * 云开发封装服务。
 * 目标 wx API：wx.cloud.callFunction、wx.cloud.database().collection().watch
 */
export interface ICloudService {
    /** 初始化云环境（第二阶段 wx.cloud.init）。 */
    init(): void;
    /** 调用云函数。 */
    callFunction<TReq = unknown, TRes = unknown>(name: string, data: TReq): Promise<TRes>;
    /**
     * 监听集合变化（实时数据推送）。
     * @returns 取消监听函数
     */
    watchCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
        cb: (docs: T[]) => void,
    ): () => void;
    /** 集合查询（一次性拉取，非实时）。 */
    queryCollection<T = unknown>(name: string, query: Record<string, unknown>): Promise<T[]>;
    /** 写入文档（战绩结算用）。 */
    addDocument<T = unknown>(name: string, doc: T): Promise<string>;
}
