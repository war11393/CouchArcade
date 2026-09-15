/**
 * 云函数 getRoomState —— 拉取房间全量状态（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'getRoomState', data: { roomId } })
 *
 * 用途（关键）：
 * - 断线重连兜底：客户端 watch 丢失/重连后，用本函数做一次全量对账；
 * - 进入 Room 场景时初始化；
 * - 惰性清理：发现房间超时则标记解散。
 */

const { wrap, COLLECTIONS, ROOM_STATUS, ERR, BizError, ok, requireRoom, updateRoom } = require('./common');

/** 房间超时（毫秒）：超过此时长仍未开局则自动解散。 */
const ROOM_TIMEOUT_MS = 30 * 60 * 1000;

exports.main = wrap('getRoomState', async function (ctx, event) {
    const roomId = String(event.roomId || '');

    let room;
    try {
        room = await requireRoom(ctx, roomId);
    } catch (err) {
        // 房间不存在时返回 null 而非报错，便于客户端直接回到大厅
        if (err && err.isBiz && err.code === ERR.ROOM_NOT_FOUND) {
            return ok(null);
        }
        throw err;
    }

    // 惰性超时解散（避免依赖额外的定时触发器云函数）
    const now = Date.now();
    if (
        room.status !== ROOM_STATUS.PLAYING &&
        room.status !== ROOM_STATUS.FINISHED &&
        room.status !== ROOM_STATUS.DISSOLVED &&
        room.createdAt &&
        now - room.createdAt > ROOM_TIMEOUT_MS
    ) {
        console.warn(`[getRoomState] 房间 ${roomId} 超时（${Math.round((now - room.createdAt) / 60000)} 分钟），标记解散`);
        await updateRoom(ctx, roomId, { status: ROOM_STATUS.DISSOLVED, dissolvedAt: now });
        room.status = ROOM_STATUS.DISSOLVED;
    }

    // 附带对局存档（用于断线重连时恢复棋局）
    let gameDoc = null;
    if (room.status === ROOM_STATUS.PLAYING || room.status === ROOM_STATUS.FINISHED) {
        const colName =
            room.gameId === 'planehunt' ? COLLECTIONS.GAMES_PLANEHUNT : COLLECTIONS.GAMES_GOMOKU;
        const res = await ctx.db.collection(colName).where({ roomId: roomId }).get();
        if (res.data && res.data.length > 0) {
            gameDoc = res.data[0];
        }
    }

    console.log(`[getRoomState] room=${roomId} status=${room.status} hasGameDoc=${!!gameDoc}`);
    return ok({ room: room, game: gameDoc });
});
