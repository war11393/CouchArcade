/**
 * 云函数 joinRoom —— 加入房间 / 离开房间（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'joinRoom', data: { roomId, action } })
 *   action 省略或 'join' → 入座
 *   action 'leave'       → 退出房间
 *
 * 并发保护（关键）：
 * 两位玩家同时抢同一座位会导致数据错乱。本函数采用「先读后条件更新」+
 * 更新条件中带 seats 当前值的乐观锁思路：
 *   - 用 where({ roomId, status: WAITING, 'seats.<i>.playerId': '' }) 作为更新条件，
 *     只有座位仍为空时才写入；
 *   - 若 updated === 0 表示竞争失败，换下一个空位或返回房间已满。
 */

const {
    wrap,
    COLLECTIONS,
    ROOM_STATUS,
    ERR,
    BizError,
    ok,
    requireRoom,
    findSeatIndex,
    updateRoom,
    upsertUser,
} = require('./common');

exports.main = wrap('joinRoom', async function (ctx, event) {
    const roomId = String(event.roomId || '');
    const action = event.action === 'leave' ? 'leave' : 'join';

    const room = await requireRoom(ctx, roomId);

    if (action === 'leave') {
        return await leaveRoom(ctx, room);
    }
    return await joinSeat(ctx, room, event);
});

/** 加入房间：抢占第一个空座位。 */
async function joinSeat(ctx, room, event) {
    // 已在房间内 → 幂等返回
    const existing = findSeatIndex(room, ctx.openid);
    if (existing >= 0) {
        console.log(`[joinRoom] 已在房间 ${room.roomId} 座位 ${existing}，幂等返回`);
        return ok(room);
    }

    if (room.status === ROOM_STATUS.PLAYING) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '房间已开局，无法加入');
    }
    if (room.status === ROOM_STATUS.FINISHED) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '本局已结束，请创建新房间');
    }

    const user = await upsertUser(ctx, event.nickname, event.avatarUrl);

    // 找第一个空座位
    const emptyIndex = room.seats.findIndex(function (s) {
        return !s.playerId;
    });
    if (emptyIndex < 0) {
        throw new BizError(ERR.ROOM_FULL, '房间已满');
    }

    const seat = {
        seatIndex: emptyIndex,
        playerId: ctx.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        ready: false,
        online: true,
        isOwner: false,
        isAI: false,
        aiLevel: room.seats[emptyIndex].aiLevel || 2,
        score: 0,
    };

    // 乐观锁：仅当该座位仍为空时才写入
    const seats = room.seats.slice();
    seats[emptyIndex] = seat;

    const res = await ctx.db
        .collection(COLLECTIONS.ROOMS)
        .where({
            roomId: room.roomId,
            status: ROOM_STATUS.WAITING,
            ['seats.' + emptyIndex + '.playerId']: '',
        })
        .update({ data: { seats: seats, updatedAt: Date.now() } });

    if (res.stats.updated === 0) {
        // 竞争失败：重试一次（可能有人同时入座）
        console.warn(`[joinRoom] 座位 ${emptyIndex} 抢占失败，重试`);
        const fresh = await requireRoom(ctx, room.roomId);
        return await joinSeat(ctx, fresh, event);
    }

    // 全员入座 → 状态推进到 READY（等待全员准备）
    const allSeated = seats.every(function (s) {
        return !!s.playerId;
    });
    if (allSeated) {
        await updateRoom(ctx, room.roomId, { status: ROOM_STATUS.WAITING });
    }

    const updated = await requireRoom(ctx, room.roomId);
    console.log(`[joinRoom] openid=${ctx.openid} 入座 ${emptyIndex} 房间=${room.roomId}`);
    return ok(updated);
}

/** 离开房间：清空座位；房主离开则移交房主。 */
async function leaveRoom(ctx, room) {
    const idx = findSeatIndex(room, ctx.openid);
    if (idx < 0) {
        console.log(`[joinRoom] openid=${ctx.openid} 不在房间 ${room.roomId}，幂等返回`);
        return ok(room);
    }

    const seats = room.seats.slice();
    const wasOwner = seats[idx].isOwner;

    // 对局中退出 → 房间判负由 settleGame 处理，这里仅标记座位离线
    if (room.status === ROOM_STATUS.PLAYING) {
        seats[idx].online = false;
        await updateRoom(ctx, room.roomId, { seats: seats });
        console.log(`[joinRoom] 对局中玩家 ${ctx.openid} 离线（座位 ${idx}）`);
        return ok(Object.assign({}, room, { seats: seats }));
    }

    // 非对局中：清空座位
    seats[idx] = {
        seatIndex: idx,
        playerId: '',
        nickname: '',
        avatarUrl: '',
        ready: false,
        online: false,
        isOwner: false,
        isAI: false,
        aiLevel: seats[idx].aiLevel || 2,
        score: 0,
    };

    let status = room.status;
    let ownerId = room.ownerId;

    // 房主离开：移交给下一个有人的座位；无人则解散房间
    if (wasOwner) {
        const nextOwner = seats.find(function (s) {
            return !!s.playerId;
        });
        if (nextOwner) {
            nextOwner.isOwner = true;
            ownerId = nextOwner.playerId;
            console.log(`[joinRoom] 房主移交给 ${ownerId}`);
        } else {
            status = ROOM_STATUS.DISSOLVED;
            console.log(`[joinRoom] 房间 ${room.roomId} 已解散（无人）`);
        }
    }

    // 有人退座 → 准备状态需要重算（可能从 READY 回到 WAITING）
    if (status === ROOM_STATUS.READY) {
        const allReady = seats.every(function (s) {
            return !!s.playerId && s.ready;
        });
        if (!allReady) {
            status = ROOM_STATUS.WAITING;
        }
    }

    await updateRoom(ctx, room.roomId, { seats: seats, status: status, ownerId: ownerId });

    const updated = await requireRoom(ctx, room.roomId);
    return ok(updated);
}
