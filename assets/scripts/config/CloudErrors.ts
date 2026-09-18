/**
 * 云端错误码与错误类型（客户端侧）。
 *
 * 错误码必须与服务端 `cloudfunctions/common/index.js` 的 `ERR` **严格一致**
 * （业务码 4xxx / 5xxx 段），否则客户端无法按码分支处理。
 *
 * 用法：
 *   try { await services.cloud.callFunction(...) }
 *   catch (e) { if (e instanceof CloudError && e.code === ERR.ROOM_FULL) { ... } }
 */

/** 统一业务错误码（与 cloudfunctions/common/index.js 的 ERR 对齐）。 */
export const ERR = {
    /** 成功。 */
    OK: 0,

    // ---------- 业务错误（服务端返回，4xxx） ----------
    /** 房间不存在。 */
    ROOM_NOT_FOUND: 4001,
    /** 房间已满。 */
    ROOM_FULL: 4002,
    /** 房间已开局。 */
    ROOM_ALREADY_STARTED: 4003,
    /** 房间已解散。 */
    ROOM_DISSOLVED: 4004,
    /** 非房主，无权限。 */
    NOT_OWNER: 4005,
    /** 未全员准备。 */
    NOT_ALL_READY: 4006,
    /** 非法操作。 */
    INVALID_MOVE: 4007,
    /** 未轮到你行动。 */
    NOT_YOUR_TURN: 4008,
    /** 未授权 / 登录态失效。 */
    UNAUTHORIZED: 4009,

    // ---------- 服务端内部错误（5xxx） ----------
    /** 服务器内部错误。 */
    INTERNAL: 5000,

    // ---------- 客户端本地错误（9xxx，仅本地使用，不会与服务端冲突） ----------
    /** 当前环境无 wx.cloud（多为 USE_MOCK 配置错误）。 */
    NO_CLOUD: 9001,
    /** callFunction 抛异常（未部署 / 网络失败）。 */
    CALL_FAIL: 9002,
    /** 云函数返回体为空或格式不符。 */
    BAD_RESPONSE: 9003,
    /** 未分类错误。 */
    UNKNOWN: 9999,
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

/** 客户端可读的错误码说明（用于 UI 提示）。 */
const ERR_TEXT: Record<number, string> = {
    [ERR.ROOM_NOT_FOUND]: '房间不存在，请确认房间号',
    [ERR.ROOM_FULL]: '房间人数已满',
    [ERR.ROOM_ALREADY_STARTED]: '房间已开始对局',
    [ERR.ROOM_DISSOLVED]: '房间已解散',
    [ERR.NOT_OWNER]: '只有房主可以开始对局',
    [ERR.NOT_ALL_READY]: '还有玩家未准备',
    [ERR.INVALID_MOVE]: '操作不合法',
    [ERR.NOT_YOUR_TURN]: '还没轮到你',
    [ERR.UNAUTHORIZED]: '登录状态失效，请重启小游戏',
    [ERR.INTERNAL]: '服务器繁忙，请稍后重试',
    [ERR.NO_CLOUD]: '当前不在微信小游戏环境',
    [ERR.CALL_FAIL]: '网络异常，请检查网络后重试',
    [ERR.BAD_RESPONSE]: '服务器返回异常',
    [ERR.UNKNOWN]: '操作失败',
};

/** 取错误码对应的用户可读文案。 */
export function errText(code: number): string {
    return ERR_TEXT[code] ?? ERR_TEXT[ERR.UNKNOWN];
}

/**
 * 云端/平台错误。
 *
 * 业务层应优先按 `code` 分支，`message` 仅用于日志与兜底展示。
 */
export class CloudError extends Error {
    /** 业务错误码（见 ERR）。 */
    public readonly code: number;

    constructor(code: number, message: string) {
        super(message);
        this.name = 'CloudError';
        this.code = code;
        // 修复 prototype 链：target=ES2017 下继承内置 Error 需要手动设置，
        // 否则 `e instanceof CloudError` 会失效（TS 编译到 ES5 时的经典坑）。
        Object.setPrototypeOf(this, CloudError.prototype);
    }

    /** 用户可读文案。 */
    public get userText(): string {
        return errText(this.code);
    }
}

/** 类型守卫：是否为 CloudError。 */
export function isCloudError(e: unknown): e is CloudError {
    return e instanceof CloudError;
}
