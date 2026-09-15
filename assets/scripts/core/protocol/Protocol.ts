/**
 * 对局消息协议定义（客户端 ↔ 服务器/Mock 完全同构）。
 *
 * 统一信封：{ cmd, roomId, playerId, payload, timestamp }
 *
 * 关键设计：Mock 联机 = 通过完全相同的同步协议通道与 AI 对打。
 * MockNetSync 会把本地 AI 的决策封装成与真实服务器一模一样的下行消息回传，
 * 因此第一阶段即可验证协议与同步逻辑，第二阶段切云函数时业务层零改动。
 */

import { GameId } from '../../config/GameList';

/** 协议命令字。 */
export enum Cmd {
    // ---------- 房间级（IRoomService，通常走云函数） ----------
    ROOM_JOIN = 'room.join',
    ROOM_LEAVE = 'room.leave',
    ROOM_READY = 'room.ready',
    ROOM_START = 'room.start',
    ROOM_STATE = 'room.state',
    ROOM_DISSOLVE = 'room.dissolve',

    // ---------- 对局会话级（INetSyncService） ----------
    /** 对局开始，携带首手方与随机种子 */
    GAME_START = 'game.start',
    /** 回合切换 */
    GAME_TURN = 'game.turn',
    /** 对局结束 */
    GAME_OVER = 'game.over',
    /** 投降 */
    GAME_SURRENDER = 'game.surrender',
    /** 心跳 */
    GAME_PING = 'game.ping',
    /** 表情快捷互动 */
    GAME_EMOTE = 'game.emote',
    /** 断线/重连 */
    GAME_OFFLINE = 'game.offline',
    GAME_RECONNECT = 'game.reconnect',
    /** 请求全量状态（重连后补偿丢失的棋步） */
    GAME_RESYNC = 'game.resync',

    // ---------- 寻机头 ----------
    /** 请求翻格（上行） */
    PH_FLIP = 'ph.flip',
    /** 翻格结果（下行，服务器权威） */
    PH_FLIP_RESULT = 'ph.flip.result',
    /** 布局同步（开局一次性下发，仅用于渲染，不含明文机头坐标） */
    PH_LAYOUT = 'ph.layout',

    // ---------- 五子棋 ----------
    /** 请求落子（上行） */
    GK_MOVE = 'gk.move',
    /** 落子结果（下行，服务器权威） */
    GK_MOVE_RESULT = 'gk.move.result',

    // ---------- 系统 ----------
    /** 通用错误 */
    SYS_ERROR = 'sys.error',
}

/** 协议信封。 */
export interface ProtocolEnvelope<T = unknown> {
    cmd: string;
    roomId: string;
    playerId: string;
    payload: T;
    timestamp: number;
}

// ==========================================================================
// 各命令的 payload 类型（强类型收发，便于单元测试）
// ==========================================================================

export interface GameStartPayload {
    gameId: GameId;
    /** 先手玩家 playerId */
    firstPlayerId: string;
    /** 随机种子（布局/一切随机行为都基于它，保证双端一致） */
    seed: number;
    /** 服务器时间戳，用于校准计时器 */
    serverTime: number;
}

export interface GameTurnPayload {
    /** 当前该谁行动 */
    playerId: string;
    /** 本回合剩余毫秒 */
    remainMs: number;
    /** 回合序号，从 1 开始，用于丢包检测 */
    turnSeq: number;
}

export interface GameOverPayload {
    /** 胜者 playerId；平局为 '' */
    winnerId: string;
    /** 是否平局 */
    draw: boolean;
    /** 结束原因 */
    reason: 'win' | 'draw' | 'surrender' | 'timeout' | 'offline' | 'leave';
    /** 各玩家数据（得分/步数） */
    stats: Array<{ playerId: string; score: number; moves: number }>;
}

/** 寻机头：请求翻格。 */
export interface PhFlipPayload {
    row: number;
    col: number;
    /** 客户端请求序号，防止重复点击 */
    reqSeq: number;
}

/** 寻机头：翻格结果（服务器权威）。 */
export interface PhFlipResultPayload {
    row: number;
    col: number;
    /** 0=空 1=机身 2=机头（服务器返回该格真实内容） */
    cell: 0 | 1 | 2;
    /** 该玩家是否得分（翻中机头） */
    scored: boolean;
    /** 是否获得奖励连翻 */
    extraTurn: boolean;
    /** 当前累计已翻出的机头数 */
    headsFound: number;
    /** 该玩家的累计得分 */
    score: number;
    /** 下一步该谁行动 */
    nextPlayerId: string;
    /** 该格所属飞机编号（-1 表示非飞机），用于 UI 高亮整机 */
    planeIndex: number;
}

/** 寻机头：布局同步（仅下发已揭示信息，不下发明文布局）。 */
export interface PhLayoutPayload {
    size: number;
    planeCount: number;
}

/** 五子棋：落子请求。 */
export interface GkMovePayload {
    row: number;
    col: number;
    reqSeq: number;
}

/** 五子棋：落子结果。 */
export interface GkMoveResultPayload {
    row: number;
    col: number;
    /** 1=黑 2=白 */
    stone: 1 | 2;
    /** 落子方 playerId */
    playerId: string;
    /** 是否获胜 */
    win: boolean;
    /** 获胜连线（用于高亮），未获胜为空数组 */
    winLine: Array<{ row: number; col: number }>;
    /** 是否和棋（棋盘下满） */
    draw: boolean;
    /** 下一步该谁行动 */
    nextPlayerId: string;
}

export interface EmotePayload {
    emoteId: number;
}

export interface SurrenderPayload {
    /** 投降者 playerId（下行广播） */
    playerId: string;
}

export interface SysErrorPayload {
    code: number;
    message: string;
    /** 出错的原始命令 */
    cmd: string;
}

/** 表情图标清单（无需美术资源，用 emoji 字符渲染）。 */
export const EMOTES: readonly string[] = ['👍', '😄', '😭', '😡', '🤔', '🎉', '😴', '🙈'];

/**
 * 协议校验：判断收到的消息是否为合法信封。
 * 所有下行消息必须先过此函数，避免脏数据进入业务层。
 */
export function isValidEnvelope(msg: unknown): msg is ProtocolEnvelope {
    if (!msg || typeof msg !== 'object') {
        return false;
    }
    const m = msg as Record<string, unknown>;
    return (
        typeof m.cmd === 'string' &&
        m.cmd.length > 0 &&
        typeof m.roomId === 'string' &&
        typeof m.playerId === 'string' &&
        typeof m.timestamp === 'number'
    );
}

/** 构造协议信封（统一出口，保证字段齐全）。 */
export function makeEnvelope<T>(
    cmd: string,
    roomId: string,
    playerId: string,
    payload: T,
): ProtocolEnvelope<T> {
    return {
        cmd,
        roomId,
        playerId,
        payload,
        timestamp: Date.now(),
    };
}
