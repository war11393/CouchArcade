/**
 * 云函数公共模块（第二阶段部署）。
 *
 * 所有云函数共享：云初始化、集合名常量、统一响应封装、入参校验、房间工具。
 *
 * 部署方式：把本文件复制到每个云函数目录下（微信云函数不支持跨目录 require），
 * 或使用「云函数公共依赖层」。本阶段为源码交付，不执行部署。
 *
 * ⚠️ 本目录代码运行在微信云函数 Node.js 环境，不在小游戏客户端中，
 *    因此这里允许使用 wx-server-sdk（服务端 SDK），不受「客户端禁止 wx.*」约束。
 */

const cloud = require('wx-server-sdk');

/** 云数据库集合名（必须与客户端 config/Collections.ts 完全一致）。 */
const COLLECTIONS = {
    USERS: 'users',
    ROOMS: 'rooms',
    GAMES_PLANEHUNT: 'games_planehunt',
    GAMES_GOMOKU: 'games_gomoku',
    MATCH_RECORDS: 'match_records',
};

/** 房间状态机（与客户端 RoomStatus 枚举一致）。 */
const ROOM_STATUS = {
    WAITING: 'waiting',
    READY: 'ready',
    PLAYING: 'playing',
    FINISHED: 'finished',
    DISSOLVED: 'dissolved',
};

/** 统一业务错误码（与客户端 docs/PROTOCOL.md 约定一致）。 */
const ERR = {
    OK: 0,
    ROOM_NOT_FOUND: 4001,
    ROOM_FULL: 4002,
    ROOM_ALREADY_STARTED: 4003,
    ROOM_DISSOLVED: 4004,
    NOT_OWNER: 4005,
    NOT_ALL_READY: 4006,
    INVALID_MOVE: 4007,
    NOT_YOUR_TURN: 4008,
    UNAUTHORIZED: 4009,
    INTERNAL: 5000,
};

/** 云函数调用方式标记：小程序端 / 云函数间调用。 */
const SOURCE = {
    WX_CLIENT: 'wx_client',
    SERVER: 'server',
    UNKNOWN: 'unknown',
};

/**
 * 初始化云环境（每个云函数入口处调用一次）。
 * @returns {{ db: any, _: any, $: any, openid: string, appid: string, unionid: string }}
 */
function init() {
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    const db = cloud.database();
    const wxContext = cloud.getWXContext();
    return {
        db,
        _: db.command,
        $: db.command.aggregate,
        openid: wxContext.OPENID || '',
        appid: wxContext.APPID || '',
        unionid: wxContext.UNIONID || '',
    };
}

/**
 * 统一成功响应。
 *
 * 注意：云函数返回值必须可 JSON 序列化，且单次上限 1MB。
 */
function ok(data, extra) {
    return Object.assign({ code: ERR.OK, success: true, data: data === undefined ? null : data }, extra || {});
}

/** 统一失败响应（不抛异常，避免客户端拿到难解析的错误堆栈）。 */
function fail(code, message) {
    return { code, success: false, message: message || '操作失败' };
}

/** 业务异常：在 handler 内 throw new BizError(ERR.xxx, '...') 会被包装成 fail 响应。 */
class BizError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.isBiz = true;
    }
}

/**
 * 云函数入口包装器：统一 try/catch、错误码转换与日志。
 *
 * @param {string} name 云函数名（日志用）
 * @param {(ctx: object, event: object) => Promise<any>} handler 业务处理器
 */
function wrap(name, handler) {
    return async function (event) {
        const start = Date.now();
        let ctx;
        try {
            ctx = init();
            console.log(`[${name}] ← 调用 openid=${ctx.openid} event=${JSON.stringify(event)}`);
            const result = await handler(ctx, event || {});
            const resp = result && result.__isResponse ? result : ok(result);
            console.log(`[${name}] → 成功 耗时=${Date.now() - start}ms resp=${JSON.stringify(resp)}`);
            return resp;
        } catch (err) {
            if (err && err.isBiz) {
                console.warn(`[${name}] → 业务失败 code=${err.code} msg=${err.message}`);
                return fail(err.code, err.message);
            }
            console.error(`[${name}] → 异常`, err && err.stack ? err.stack : err);
            return fail(ERR.INTERNAL, (err && err.message) || '服务器内部错误');
        }
    };
}

/** 生成 6 位数字房间号（不含前导零，保证客户端正则 ^\d{6}$ 通过）。 */
function genRoomId() {
    return String(100000 + Math.floor(Math.random() * 900000));
}

/**
 * 生成确定性随机种子。
 * 客户端与服务端使用同一套 mulberry32 算法（见 PlaneHuntLayout.ts 的 Rng），
 * 保证「服务端生成布局 → 客户端可校验」一致。
 */
function genSeed() {
    return Math.floor(Math.random() * 2147483647);
}

/** mulberry32 确定性随机数（与客户端完全同算法，重放布局用）。 */
function makeRng(seed) {
    let state = seed >>> 0;
    if (state === 0) {
        state = 0x9e3779b9;
    }
    return {
        next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
        int(min, max) {
            return Math.floor(min + this.next() * (max - min + 1));
        },
        pick(arr) {
            return arr[this.int(0, arr.length - 1)];
        },
    };
}

/**
 * 读取房间，不存在或已解散则抛业务异常。
 * @param {object} ctx init() 返回的上下文
 * @param {string} roomId 房间号
 */
async function requireRoom(ctx, roomId) {
    if (!roomId || !/^\d{6}$/.test(String(roomId))) {
        throw new BizError(ERR.ROOM_NOT_FOUND, '房间号格式不正确');
    }
    const res = await ctx.db.collection(COLLECTIONS.ROOMS).where({ roomId: String(roomId) }).get();
    if (!res.data || res.data.length === 0) {
        throw new BizError(ERR.ROOM_NOT_FOUND, '房间不存在');
    }
    const room = res.data[0];
    if (room.status === ROOM_STATUS.DISSOLVED) {
        throw new BizError(ERR.ROOM_DISSOLVED, '房间已解散');
    }
    return room;
}

/** 查找玩家在房间中的座位索引（-1 表示未入座）。 */
function findSeatIndex(room, openid) {
    if (!room || !Array.isArray(room.seats)) {
        return -1;
    }
    return room.seats.findIndex(function (s) {
        return s.playerId === openid;
    });
}

/** 更新房间文档（按 _id 精确定位）。 */
async function updateRoom(ctx, roomId, patch) {
    await ctx.db
        .collection(COLLECTIONS.ROOMS)
        .where({ roomId: String(roomId) })
        .update({ data: Object.assign({ updatedAt: Date.now() }, patch) });
}

/** upsert 用户（首次登录创建）。 */
async function upsertUser(ctx, nickName, avatarUrl) {
    const col = ctx.db.collection(COLLECTIONS.USERS);
    const existing = await col.where({ openid: ctx.openid }).get();
    const now = Date.now();
    if (existing.data && existing.data.length > 0) {
        const user = existing.data[0];
        const patch = { lastLoginAt: now };
        if (nickName && nickName !== user.nickname) {
            patch.nickname = nickName;
        }
        if (avatarUrl && avatarUrl !== user.avatarUrl) {
            patch.avatarUrl = avatarUrl;
        }
        await col.doc(user._id).update({ data: patch });
        return Object.assign(user, patch);
    }
    const doc = {
        openid: ctx.openid,
        unionid: ctx.unionid || '',
        nickname: nickName || '微信用户',
        avatarUrl: avatarUrl || '',
        winCount: 0,
        loseCount: 0,
        drawCount: 0,
        createdAt: now,
        lastLoginAt: now,
    };
    const added = await col.add({ data: doc });
    doc._id = added._id;
    return doc;
}

module.exports = {
    cloud,
    COLLECTIONS,
    ROOM_STATUS,
    ERR,
    SOURCE,
    init,
    ok,
    fail,
    wrap,
    BizError,
    genRoomId,
    genSeed,
    makeRng,
    requireRoom,
    findSeatIndex,
    updateRoom,
    upsertUser,
};
