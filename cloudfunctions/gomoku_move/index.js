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

const {
    GomokuBoardView,
    gomokuDecide,
} = require('./server-ai');

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
    // 这三个会被 AI 回手改写，故用 let（const 会在回手时报
    // "Assignment to constant variable" —— 端到端仿真抓到过）
    let finished = winCheck.win || moveCount >= game.size * game.size;
    let draw = !winCheck.win && finished;
    let winnerId = winCheck.win ? ctx.openid : '';
    let nextPlayerId = finished ? game.currentPlayerId : otherPlayer(room, ctx.openid);

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
            // ⚠️ lastMove 是**客户端 watch 的字段**（见 WxNetSyncService._handleGameDoc：
            //    它按 moveCount 增量 + lastMove 派发 GK_MOVE_RESULT）。
            //    只写 history 而不写 lastMove，客户端永远收不到任何落子 ——
            //    表现为「落子后双方界面都不动」。权威数据仍以 board/history 为准。
            lastMove: {
                row: row,
                col: col,
                stone: stone,
                playerId: ctx.openid,
            },
            updatedAt: Date.now(),
        },
    });

    // ---- AI 回手（方案 B：练习房的 AI 由服务端代打） ----
    //
    // 触发条件：对局未结束 && 轮到 AI 座位。
    // 为什么放在同一个云函数里而不是定时器/独立触发器：
    //   · AI 练习是「一人 + AI」，回手必须紧跟人类那一手，
    //     独立调度要处理并发与顺序，成本更高且更难保证一致性；
    //   · 同函数内串行执行天然幂等：人类这手成功写库后才轮到 AI，
    //     冷启动/重试都不会产生「AI 连下两手」。
    // 注意：AI 落子**复用同一套写入逻辑**（棋盘/五连/回合），
    //   因此与联机走同一条代码路径，规则不会漂移。
    let aiMove = null;
    if (!finished) {
        aiMove = await applyAiMoveIfNeeded(ctx, {
            colName: colName,
            gameDocId: game._id,
            room: room,
            board: board,
            history: history,
            moveCount: moveCount,
            currentPlayerId: nextPlayerId,
            size: game.size,
            winCount: game.winCount,
            seed: game.seed || room.seed || 0,
            // 人类这手的坐标与颜色：用于单独判定「人类是否成五」，
            // 避免 AI 回手后把它冲掉
            lastRow: row,
            lastCol: col,
            lastStone: stone,
        });
        if (aiMove) {
            // AI 落子可能直接结束对局（AI 自己成五 / 和棋）
            finished = aiMove.finished;
            winnerId = aiMove.winnerId;
            draw = aiMove.draw;
            winCheck.line = aiMove.winLine;
            nextPlayerId = aiMove.nextPlayerId;
        }
    }

    console.log(
        `[gomoku_move] room=${roomId} (${row},${col}) stone=${stone} win=${winCheck.win} ` +
            `moves=${moveCount}${aiMove ? ` → AI(${aiMove.row},${aiMove.col})` : ''} ` +
            `next=${nextPlayerId}`,
    );

    return ok({
        row: row,
        col: col,
        stone: stone,
        playerId: ctx.openid,
        win: !!(aiMove ? aiMove.humanWin : winCheck.win),
        winLine: aiMove ? (aiMove.humanWin ? aiMove.humanWinLine : []) : winCheck.line,
        draw: draw,
        nextPlayerId: nextPlayerId,
        moveCount: aiMove ? aiMove.moveCount : moveCount,
        // 人类这手的五连信息（AI 回手不该覆盖它）
        // 说明：这里显式区分「人类是否成五」与「AI 是否成五」，
        // 否则 AI 回手后会把人赢了这一事实冲掉。
        humanWin: !!(aiMove ? aiMove.humanWin : winCheck.win),
        /** AI 回手（供客户端立即渲染；客户端也会从 watch 收到同一份数据） */
        aiMove: aiMove
            ? {
                row: aiMove.row,
                col: aiMove.col,
                stone: aiMove.stone,
                playerId: aiMove.aiPlayerId,
                win: aiMove.aiWin,
                winLine: aiMove.aiWin ? aiMove.winLine : [],
            }
            : null,
    });
});

/**
 * 若轮到 AI 座位则替它落一手，并写库。
 *
 * @returns 追加信息（含人类这手的胜负，避免被 AI 回手覆盖）；未落子返回 null
 */
async function applyAiMoveIfNeeded(ctx, st) {
    // 找到下一手该谁下对应的座位；不是 AI 就什么都不做（联机路径）
    const seatIdx = st.room.seats.findIndex(function (s) {
        return s.playerId === st.currentPlayerId;
    });
    if (seatIdx < 0) {
        return null;
    }
    const seat = st.room.seats[seatIdx];
    if (!seat.isAI) {
        return null;
    }

    // 人类这手的五连结果（AI 回手前先记住，供返回体使用）
    const humanCheck = checkWin(st.board, st.lastRow, st.lastCol, st.lastStone,
        st.winCount);

    const view = new GomokuBoardView(
        st.board,
        st.size,
        st.winCount,
        st.room.seats[0].playerId,
        st.room.seats[1] ? st.room.seats[1].playerId : st.currentPlayerId,
    );
    // 只做决策、不应用落子，所以要把「当前该谁下」对齐库里的权威值 ——
    // 否则首手天元/候选裁剪会按错误的回合算。
    view._currentPlayerId = st.currentPlayerId;

    const aiLevel = seat.aiLevel || 2;
    const decision = pickAiDecision(view, seat, st, aiLevel);
    if (!decision) {
        return null; // 无可用落点（理论上不会发生）
    }

    // 写入棋盘
    const aiStone = seatIdx === 0 ? 1 : 2;
    st.board[decision.row][decision.col] = aiStone;
    const aiMoveCount = st.moveCount + 1;
    st.history.push({
        row: decision.row,
        col: decision.col,
        playerId: seat.playerId,
        stone: aiStone,
        at: Date.now(),
        byAI: true,
    });

    const aiCheck = checkWin(st.board, decision.row, decision.col, aiStone, st.winCount);
    const aiFinished = aiCheck.win || aiMoveCount >= st.size * st.size;
    const aiDraw = !aiCheck.win && aiFinished;
    const aiWinnerId = aiCheck.win ? seat.playerId : '';
    const nextPlayerId = aiFinished ? seat.playerId : st.room.seats[0].playerId;

    await ctx.db.collection(st.colName).doc(st.gameDocId).update({
        data: {
            board: st.board,
            history: st.history,
            moveCount: aiMoveCount,
            currentPlayerId: nextPlayerId,
            finished: aiFinished,
            winnerId: aiWinnerId,
            draw: aiDraw,
            winLine: aiCheck.line,
            // 同人类那手：客户端按 lastMove + moveCount 增量派发，
            // 必须写上来它才知道 AI 落子了（否则人类界面卡在「对手思考中」）
            lastMove: {
                row: decision.row,
                col: decision.col,
                stone: aiStone,
                playerId: seat.playerId,
            },
            updatedAt: Date.now(),
        },
    });

    return {
        row: decision.row,
        col: decision.col,
        stone: aiStone,
        aiPlayerId: seat.playerId,
        aiWin: aiCheck.win,
        aiFinished: aiFinished,
        winLine: aiCheck.line,
        draw: aiDraw,
        winnerId: aiWinnerId,
        moveCount: aiMoveCount,
        nextPlayerId: nextPlayerId,
        // 人类这手的结果（不被 AI 回手覆盖）
        humanWin: humanCheck.win,
        humanWinLine: humanCheck.line,
        finished: aiFinished || humanCheck.win,
    };
}

/** AI 决策分发（按游戏类型）。 */
function pickAiDecision(view, seat, st, aiLevel) {
    // 目前只有五子棋走本文件；寻机头在 planehunt_flip 里（同构写法）
    const firstId = st.room.seats[0].playerId;
    return gomokuDecide(view, seat.playerId, firstId, aiLevel);
}

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
