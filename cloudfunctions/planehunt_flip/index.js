/**
 * 云函数 planehunt_flip —— 寻机头翻格（服务端权威，第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({
 *          name: 'planehunt_flip',
 *          data: { roomId, row, col, reqSeq }
 *       })
 *
 * 返回：{ code, success, data: { row, col, cell, scored, extraTurn,
 *          headsFound, score, nextPlayerId, planeIndex } }
 *
 * 本函数是「杜绝篡改」的核心：
 * - 客户端只提交「我想翻 (r,c)」，不知道那里是什么；
 * - 服务端查权威布局后返回该格真实内容；
 * - 幂等：同一格重复请求直接返回既有结果，不会重复计分；
 * - 翻中机头奖励额外一次翻格（连续奖励），服务端不切换回合。
 */

const {
    wrap,
    COLLECTIONS,
    ROOM_STATUS,
    ERR,
    BizError,
    ok,
    requireRoom,
} = require('./common');

exports.main = wrap('planehunt_flip', async function (ctx, event) {
    const roomId = String(event.roomId || '');
    const row = Number(event.row);
    const col = Number(event.col);

    const room = await requireRoom(ctx, roomId);
    if (room.status !== ROOM_STATUS.PLAYING) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '对局未在进行中');
    }

    const colName = COLLECTIONS.GAMES_PLANEHUNT;
    const res = await ctx.db.collection(colName).where({ roomId: roomId }).get();
    if (!res.data || res.data.length === 0) {
        throw new BizError(ERR.INVALID_MOVE, '对局数据不存在');
    }
    const game = res.data[0];

    if (game.finished) {
        throw new BizError(ERR.INVALID_MOVE, '对局已结束');
    }
    if (game.currentPlayerId !== ctx.openid) {
        throw new BizError(ERR.NOT_YOUR_TURN, '还没轮到你翻格');
    }
    if (row < 0 || row >= game.size || col < 0 || col >= game.size) {
        throw new BizError(ERR.INVALID_MOVE, `翻格越界 (${row},${col})`);
    }

    const cellKey = row + ',' + col;
    const revealed = game.revealed || {};

    // 幂等：已翻开的格子直接返回既有结果
    if (revealed[cellKey]) {
        const r = revealed[cellKey];
        console.log(`[planehunt_flip] ${cellKey} 已翻开，幂等返回`);
        return ok({
            row: row,
            col: col,
            cell: r.cell,
            scored: false,
            extraTurn: false,
            headsFound: game.headsFound,
            score: (game.scores && game.scores[ctx.openid]) || 0,
            nextPlayerId: game.currentPlayerId,
            planeIndex: r.planeIndex,
            idempotent: true,
        });
    }

    // 从权威布局读取真实内容
    const cell = game.cells[row][col];
    const planeIndex = findPlaneIndex(game, row, col);

    revealed[cellKey] = {
        cell: cell,
        byPlayerId: ctx.openid,
        planeIndex: planeIndex,
        at: Date.now(),
    };

    const scores = game.scores || {};
    const moves = game.moves || {};
    scores[ctx.openid] = scores[ctx.openid] || 0;
    moves[ctx.openid] = (moves[ctx.openid] || 0) + 1;

    const scored = cell === 2;
    let headsFound = game.headsFound || 0;
    if (scored) {
        scores[ctx.openid] += 1;
        headsFound += 1;
    }

    const finished = headsFound >= (game.heads || []).length;
    // 翻中机头奖励额外一次（连续奖励）；否则切换回合
    const extraTurn = scored && !finished;
    let nextPlayerId = game.currentPlayerId;
    if (!extraTurn && !finished) {
        nextPlayerId = otherPlayer(room, ctx.openid);
    }

    // 结算胜负
    let winnerId = '';
    let draw = false;
    if (finished) {
        const result = judge(scores);
        winnerId = result.winnerId;
        draw = result.draw;
    }

    await ctx.db.collection(colName).doc(game._id).update({
        data: {
            revealed: revealed,
            scores: scores,
            moves: moves,
            headsFound: headsFound,
            currentPlayerId: nextPlayerId,
            finished: finished,
            winnerId: winnerId,
            draw: draw,
            updatedAt: Date.now(),
        },
    });

    console.log(
        `[planehunt_flip] room=${roomId} ${cellKey} cell=${cell} scored=${scored} ` +
            `heads=${headsFound} next=${nextPlayerId} finished=${finished}`,
    );

    return ok({
        row: row,
        col: col,
        cell: cell,
        scored: scored,
        extraTurn: extraTurn,
        headsFound: headsFound,
        score: scores[ctx.openid],
        nextPlayerId: nextPlayerId,
        planeIndex: planeIndex,
    });
});

/** 由权威布局反查该格所属飞机编号。 */
function findPlaneIndex(game, row, col) {
    const heads = game.heads || [];
    const cells = game.cells;
    if (!cells) {
        return -1;
    }
    // 服务端未单独存 planeIndexAt，用洪水法在 cells 上做局部推导代价高，
    // 这里改为：cells 值非 0 的格子统一返回 0 号飞机标记，
    // 精确的「整机高亮」由客户端根据已揭示格子自行聚合（视觉需求，非权威数据）。
    if (cells[row][col] === 0) {
        return -1;
    }
    // 找到包含该格机头的飞机（若该格本身不是机头，则返回最接近的机头索引）
    for (let i = 0; i < heads.length; i++) {
        if (heads[i].row === row && heads[i].col === col) {
            return heads[i].planeIndex;
        }
    }
    return 0;
}

/** 取对手 playerId。 */
function otherPlayer(room, openid) {
    const other = room.seats.find(function (s) {
        return s.playerId !== openid;
    });
    return other ? other.playerId : '';
}

/** 判定胜负：机头多者胜，相同平局。 */
function judge(scores) {
    let max = -1;
    let leader = '';
    let tie = false;
    Object.keys(scores).forEach(function (pid) {
        const v = scores[pid];
        if (v > max) {
            max = v;
            leader = pid;
            tie = false;
        } else if (v === max) {
            tie = true;
        }
    });
    if (tie) {
        return { winnerId: '', draw: true };
    }
    return { winnerId: leader, draw: false };
}
