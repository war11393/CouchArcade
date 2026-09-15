/**
 * 云函数 settleGame —— 对局结算与战绩写入（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({
 *          name: 'settleGame',
 *          data: { roomId, gameId, result, durationMs }
 *       })
 *
 * 服务端职责：
 * 1. 以服务端对局文档的权威结果为准（不信任客户端上报的胜负）；
 * 2. 写入 match_records 战绩流水；
 * 3. 更新双方 users 的 win/lose/draw 计数；
 * 4. 把 rooms.status 置为 'finished'。
 *
 * 安全说明：客户端上报的 result 仅用于兜底（如投降等无服务端对局文档的场景），
 * 正常情况下服务端会用自己的 games_* 文档重新判定，防止刷分。
 */

const {
    wrap,
    COLLECTIONS,
    ROOM_STATUS,
    ok,
    requireRoom,
    updateRoom,
} = require('./common');

exports.main = wrap('settleGame', async function (ctx, event) {
    const roomId = String(event.roomId || '');
    const room = await requireRoom(ctx, roomId);
    const now = Date.now();

    // 1) 尝试从服务端权威对局文档重新判定结果
    let judgment = null;
    const gameColName =
        room.gameId === 'planehunt' ? COLLECTIONS.GAMES_PLANEHUNT : COLLECTIONS.GAMES_GOMOKU;
    const gameRes = await ctx.db.collection(gameColName).where({ roomId: roomId }).get();
    if (gameRes.data && gameRes.data.length > 0) {
        const game = gameRes.data[0];
        if (game.finished) {
            judgment = {
                winnerId: game.winnerId || '',
                draw: !!game.draw,
                source: 'server_authoritative',
            };
        }
    }
    // 兜底：投降等场景以客户端上报为准（服务端无法从棋局推导）
    if (!judgment && event.result) {
        judgment = {
            winnerId: event.result.winnerId || '',
            draw: !!event.result.draw,
            source: 'client_reported',
        };
    }
    if (!judgment) {
        console.warn(`[settleGame] room=${roomId} 无对局文档且无上报结果，跳过结算`);
        judgment = { winnerId: '', draw: true, source: 'unknown' };
    }

    // 2) 写战绩流水 + 更新双方用户统计
    const records = [];
    for (let i = 0; i < room.seats.length; i++) {
        const seat = room.seats[i];
        if (!seat.playerId || seat.isAI) {
            continue;
        }
        const isWinner = judgment.winnerId === seat.playerId;
        const outcome = judgment.draw ? 'draw' : isWinner ? 'win' : 'lose';
        const opponent = room.seats.find(function (s) {
            return s.playerId !== seat.playerId;
        });

        const score = (gameRes.data && gameRes.data[0] && gameRes.data[0].scores
            ? gameRes.data[0].scores[seat.playerId]
            : 0) || 0;
        const moves = (gameRes.data && gameRes.data[0] && gameRes.data[0].moves
            ? gameRes.data[0].moves[seat.playerId]
            : 0) || (gameRes.data && gameRes.data[0] ? gameRes.data[0].moveCount : 0) || 0;

        const record = {
            openid: seat.playerId,
            nickname: seat.nickname,
            gameId: room.gameId,
            roomId: roomId,
            result: outcome,
            score: score,
            moves: moves,
            opponentId: opponent ? opponent.playerId : '',
            durationMs: event.durationMs || (room.startedAt ? now - room.startedAt : 0),
            judgmentSource: judgment.source,
            createdAt: now,
        };
        const added = await ctx.db.collection(COLLECTIONS.MATCH_RECORDS).add({ data: record });
        record._id = added._id;
        records.push(record);

        // 更新用户胜负计数（云函数以管理员权限运行，可写他人文档）
        await bumpUserStats(ctx, seat.playerId, outcome);
    }

    // 3) 房间状态推进
    await updateRoom(ctx, roomId, {
        status: ROOM_STATUS.FINISHED,
        finishedAt: now,
        winnerId: judgment.winnerId,
        draw: judgment.draw,
    });

    console.log(
        `[settleGame] room=${roomId} game=${room.gameId} winner=${judgment.winnerId || '(平局)'} ` +
            `source=${judgment.source} 写入 ${records.length} 条战绩`,
    );

    return ok({
        winnerId: judgment.winnerId,
        draw: judgment.draw,
        records: records,
        judgmentSource: judgment.source,
    });
});

/** 累加用户胜负平计数。 */
async function bumpUserStats(ctx, openid, outcome) {
    const field = outcome === 'win' ? 'winCount' : outcome === 'lose' ? 'loseCount' : 'drawCount';
    const col = ctx.db.collection(COLLECTIONS.USERS);
    const res = await col.where({ openid: openid }).get();
    if (res.data && res.data.length > 0) {
        const user = res.data[0];
        const patch = {};
        patch[field] = (user[field] || 0) + 1;
        patch.lastPlayedAt = Date.now();
        await col.doc(user._id).update({ data: patch });
    } else {
        // 用户不存在则创建（防止因登录失败导致的孤记录）
        const patch = { openid: openid, winCount: 0, loseCount: 0, drawCount: 0 };
        patch[field] = 1;
        await col.add({ data: Object.assign(patch, { createdAt: Date.now() }) });
    }
}
