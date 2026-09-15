/**
 * 云函数 gomoku_move —— 五子棋落子（服务端权威，第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'gomoku_move', data: { roomId, row, col, reqSeq } })
 *
 * 服务端职责：
 * 1. 校验落子合法（轮次、越界、该位置为空）；
 * 2. 五连检测（只检测落子点四方向，O(4×winCount)）；
 * 3. 幂等：同一步 reqSeq 重复提交不会重复落子；
 * 4. 更新 currentPlayerId / board / history。
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

exports.main = wrap('gomoku_move', async function (ctx, event) {
    const roomId = String(event.roomId || '');
    const row = Number(event.row);
    const col = Number(event.col);

    const room = await requireRoom(ctx, roomId);
    if (room.status !== ROOM_STATUS.PLAYING) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '对局未在进行中');
    }

    const colName = COLLECTIONS.GAMES_GOMOKU;
    const res = await ctx.db.collection(colName).where({ roomId: roomId }).get();
    if (!res.data || res.data.length === 0) {
        throw new BizError(ERR.INVALID_MOVE, '对局数据不存在');
    }
    const game = res.data[0];

    if (game.finished) {
        throw new BizError(ERR.INVALID_MOVE, '对局已结束');
    }
    if (game.currentPlayerId !== ctx.openid) {
        throw new BizError(ERR.NOT_YOUR_TURN, '还没轮到你落子');
    }
    if (row < 0 || row >= game.size || col < 0 || col >= game.size) {
        throw new BizError(ERR.INVALID_MOVE, `落子越界 (${row},${col})`);
    }

    const board = game.board;
    // 幂等 / 合法性：该位置已有棋子
    if (board[row][col] !== 0) {
        throw new BizError(ERR.INVALID_MOVE, '该位置已有棋子');
    }

    // 棋子颜色：座位 0 = 黑(1)，座位 1 = 白(2)
    const seatIdx = room.seats.findIndex(function (s) {
        return s.playerId === ctx.openid;
    });
    const stone = seatIdx === 0 ? 1 : 2;

    board[row][col] = stone;
    const moveCount = (game.moveCount || 0) + 1;

    const history = game.history || [];
    history.push({ row: row, col: col, playerId: ctx.openid, stone: stone, at: Date.now() });

    // 五连检测（只测落子点四方向）
    const winCheck = checkWin(board, row, col, stone, game.winCount);
    const finished = winCheck.win || moveCount >= game.size * game.size;
    const draw = !winCheck.win && finished;
    const winnerId = winCheck.win ? ctx.openid : '';
    const nextPlayerId = finished ? game.currentPlayerId : otherPlayer(room, ctx.openid);

    await ctx.db.collection(colName).doc(game._id).update({
        data: {
            board: board,
            history: history,
            moveCount: moveCount,
            currentPlayerId: nextPlayerId,
            finished: finished,
            winnerId: winnerId,
            draw: draw,
            winLine: winCheck.line,
            updatedAt: Date.now(),
        },
    });

    console.log(
        `[gomoku_move] room=${roomId} (${row},${col}) stone=${stone} win=${winCheck.win} ` +
            `moves=${moveCount} next=${nextPlayerId}`,
    );

    return ok({
        row: row,
        col: col,
        stone: stone,
        playerId: ctx.openid,
        win: winCheck.win,
        winLine: winCheck.line,
        draw: draw,
        nextPlayerId: nextPlayerId,
        moveCount: moveCount,
    });
});

/**
 * 高效五连检测：仅检测 (row,col) 的四个方向。
 * 复杂度 O(4 × winCount)，与客户端 GomokuRules.checkWinAt 同构。
 */
function checkWin(board, row, col, stone, winCount) {
    const size = board.length;
    const dirs = [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
    ];

    for (let d = 0; d < dirs.length; d++) {
        const dr = dirs[d][0];
        const dc = dirs[d][1];
        const line = [{ row: row, col: col }];

        // 正方向
        for (let step = 1; step < winCount; step++) {
            const r = row + dr * step;
            const c = col + dc * step;
            if (r < 0 || r >= size || c < 0 || c >= size || board[r][c] !== stone) {
                break;
            }
            line.push({ row: r, col: c });
        }
        // 反方向
        for (let step = 1; step < winCount; step++) {
            const r = row - dr * step;
            const c = col - dc * step;
            if (r < 0 || r >= size || c < 0 || c >= size || board[r][c] !== stone) {
                break;
            }
            line.push({ row: r, col: c });
        }

        if (line.length >= winCount) {
            return { win: true, line: line };
        }
    }
    return { win: false, line: [] };
}

/** 取对手 playerId。 */
function otherPlayer(room, openid) {
    const other = room.seats.find(function (s) {
        return s.playerId !== openid;
    });
    return other ? other.playerId : '';
}
