/**
 * 云函数 ready —— 设置准备状态（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'ready', data: { ready: true } })
 *
 * 服务端职责：更新 seats[i].ready；若全员 ready 则把 rooms.status 置为 'ready'，
 * 使房主的「开始游戏」按钮可用（客户端通过 watch rooms 集合感知）。
 */

const { wrap, COLLECTIONS, ROOM_STATUS, ERR, BizError, ok, requireRoom, findSeatIndex, updateRoom } = require('./common');

exports.main = wrap('ready', async function (ctx, event) {
    const ready = !!event.ready;
    const roomId = String(event.roomId || '');

    const room = await requireRoom(ctx, roomId);
    const idx = findSeatIndex(room, ctx.openid);
    if (idx < 0) {
        throw new BizError(ERR.UNAUTHORIZED, '你不在该房间中');
    }
    if (room.status === ROOM_STATUS.PLAYING) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '对局进行中，无法修改准备状态');
    }
    if (room.status === ROOM_STATUS.DISSOLVED || room.status === ROOM_STATUS.FINISHED) {
        throw new BizError(ERR.ROOM_DISSOLVED, '房间不可用');
    }

    const seats = room.seats.slice();
    seats[idx] = Object.assign({}, seats[idx], { ready: ready, online: true });

    const allSeated = seats.every(function (s) {
        return !!s.playerId;
    });
    const allReady = seats.every(function (s) {
        return !!s.playerId && s.ready;
    });

    let status = room.status;
    if (allSeated && allReady) {
        status = ROOM_STATUS.READY;
    } else if (room.status === ROOM_STATUS.READY) {
        // 有人取消准备 → 回到等待
        status = ROOM_STATUS.WAITING;
    }

    await updateRoom(ctx, room.roomId, { seats: seats, status: status });

    console.log(
        `[ready] room=${room.roomId} openid=${ctx.openid} seat=${idx} ready=${ready} status=${status}`,
    );
    return ok(Object.assign({}, room, { seats: seats, status: status }));
});
