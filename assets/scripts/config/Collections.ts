/**
 * 云开发集合名与云函数名常量表。
 *
 * 第二阶段部署时，云函数目录名必须与本文件中的函数名严格一致，
 * 客户端通过 ICloudService.callFunction(CLOUD_FUNCTIONS.xxx, data) 调用。
 */

/** 云数据库集合名（集合设计详见 docs/CLOUD_DESIGN.md）。 */
export const COLLECTIONS = {
    /** 用户表：openid、昵称、头像、战绩统计 */
    USERS: 'users',
    /** 房间表：房间号、游戏、玩家列表、准备状态、状态机 */
    ROOMS: 'rooms',
    /** 寻机头对局表：权威布局（加密存储）、已翻格、得分、回合 */
    GAMES_PLANEHUNT: 'games_planehunt',
    /** 五子棋对局表：落子序列、当前回合 */
    GAMES_GOMOKU: 'games_gomoku',
    /** 战绩流水表：每局结算记录 */
    MATCH_RECORDS: 'match_records',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** 云函数名（第二阶段逐个部署）。 */
export const CLOUD_FUNCTIONS = {
    LOGIN: 'login',
    CREATE_ROOM: 'createRoom',
    JOIN_ROOM: 'joinRoom',
    READY: 'ready',
    START_GAME: 'startGame',
    PLANEHUNT_FLIP: 'planehunt_flip',
    GOMOKU_MOVE: 'gomoku_move',
    SETTLE_GAME: 'settleGame',
    GET_ROOM_STATE: 'getRoomState',
} as const;

export type CloudFunctionName = (typeof CLOUD_FUNCTIONS)[keyof typeof CLOUD_FUNCTIONS];

/** 本地存储 key 常量，避免散落魔法字符串。 */
export const STORAGE_KEYS = {
    USER_INFO: 'gg_user_info',
    SETTINGS: 'gg_settings',
    LAST_ROOM: 'gg_last_room',
    RECONNECT_TOKEN: 'gg_reconnect_token',
} as const;
