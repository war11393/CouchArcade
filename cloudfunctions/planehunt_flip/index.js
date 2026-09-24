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
    makeRng,
} = require('./common');

const { planeHuntDecide } = require('./server-ai');

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

    // 这三个会被 AI 回手改写，故用 let（const 会在回手时报
    // "Assignment to constant variable" —— gomoku_move 上被仿真抓到过同一坑）
    let finished = headsFound >= (game.heads || []).length;

    // 回合交接：**一律换手**（翻到机头也换），对局未结束才换。
    //
    // ⚠️ 规则漂移修正（2026-09-24，实测确证）：
    //   这里原先是 `const extraTurn = scored && !finished;` —— 即「翻中机头
    //   奖励额外一次」的旧规则。而客户端 `PlaneHuntRules.ts:249` 早已改成
    //   「翻到机头也换手」（`extraTurn` 字段保留但恒为 false，仅存档兼容）。
    //   两端不一致的后果（真机实测）：人类翻中机头后服务端把 nextPlayerId
    //   留给自己，客户端按「一定换手」理解 → isMyTurn() 判定错位 →
    //   点格子没有任何反应（与五子棋 gameId 那个 bug 同款症状）。
    //   `extraTurn` 仍在返回体里**恒为 false**，保持消息结构不变。
    // （对局结束时回合归属已无意义，故保留在最后一手方。）
    const extraTurn = false;
    let nextPlayerId = game.currentPlayerId;
    if (!finished) {
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
            // ⚠️ flips 是**客户端 watch 的字段**（见 WxNetSyncService._handleGameDoc：
            //    它按数组长度增量派发 PH_FLIP_RESULT）。
            //    只写 revealed 而不写 flips，客户端永远收不到翻格结果。
            //    ⚠️ 这里只放**已公开**的格子信息，绝不放 cells 权威布局。
            flips: appendFlip(game.flips, {
                row: row,
                col: col,
                cell: cell,
                scored: scored,
                playerId: ctx.openid,
                planeIndex: planeIndex,
            }),
            updatedAt: Date.now(),
        },
    });

    // ---- AI 回手（方案 B：练习房的 AI 由服务端代打） ----
    //
    // 与 gomoku_move 同构：人类这手成功写库后，若对局未结束且轮到 AI 座位，
    // 立刻替 AI 翻一格并写库。串行执行 ⇒ 天然幂等，不会「AI 连翻两格」。
    //
    // ⚠️ 寻机头的「翻中机头额外一次」规则对 AI 同样成立：AI 翻中机头时
    //    回合不会切回人类，此时要**继续让 AI 翻**（循环），否则会出现
    //    「AI 翻中机头后卡住、人类也点不了」的死局。
    //
    // ⚠️ flips 必须传「含人类这一手之后」的数组 —— 不能读 game.flips
    //    （那是本函数开头的旧快照）。用旧快照会让 AI 的写入**覆盖掉人类
    //    刚才那格**，客户端增量派发时就少显示一格（仿真抓到过）。
    let aiFlips = [];
    const flipsAfterHuman = appendFlip(game.flips, {
        row: row,
        col: col,
        cell: cell,
        scored: scored,
        playerId: ctx.openid,
        planeIndex: planeIndex,
    });
    if (!finished) {
        aiFlips = await runAiFlips(ctx, {
            colName: colName,
            gameDocId: game._id,
            room: room,
            game: game,
            revealed: revealed,
            scores: scores,
            moves: moves,
            flips: flipsAfterHuman,
            headsFound: headsFound,
            currentPlayerId: nextPlayerId,
        });
        if (aiFlips.length > 0) {
            const last = aiFlips[aiFlips.length - 1];
            headsFound = last.headsFound;
            nextPlayerId = last.nextPlayerId;
            finished = last.finished;
            winnerId = last.winnerId;
            draw = last.draw;
        }
    }

    console.log(
        `[planehunt_flip] room=${roomId} ${cellKey} cell=${cell} scored=${scored} ` +
            `heads=${headsFound}${aiFlips.length ? ` → AI×${aiFlips.length}` : ''} ` +
            `next=${nextPlayerId} finished=${finished}`,
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
        // ⚠️ 对局结束标志必须回传（2026-09-24 补）：
        //   原先返回体到 aiFlips 就结束了，**没有 finished / winnerId** ——
        //   文档里写对了，但客户端拿不到「这局结束了」的信号。
        //   对照五子棋的 gomoku_move：它一直有 win/draw/nextPlayerId。
        //   缺它的后果：AI 回手直接终结对局时（AI 翻中最后一个机头），
        //   客户端只能靠后续 watch 帧的 game.over 才反应过来，
        //   期间停在「等待对手」，表现与卡住无异。
        finished: finished,
        winnerId: winnerId,
        draw: draw,
        /** AI 回手序列（改为「一手即交回」后至多一格，保留数组结构兼容客户端） */
        aiFlips: aiFlips.map(function (f) {
            return {
                row: f.row,
                col: f.col,
                cell: f.cell,
                scored: f.scored,
                playerId: f.playerId,
            };
        }),
    });
});

/**
 * 让 AI 翻一格（若轮到 AI 且未结束），并写库。
 *
 * ⚠️ 2026-09-24 起规则改为「一律换手」：AI 翻一手即交回人类，
 *    不再有「翻中机头连翻」。函数名保留（调用点不动），
 *    实现内的循环也保留（防御性 + 将来若复用规则时无需重写）。
 *
 * @returns 本次 AI 的翻格序列（每次含落库后的权威状态）
 */
async function runAiFlips(ctx, st) {
    const out = [];
    let currentPlayerId = st.currentPlayerId;
    let headsFound = st.headsFound;
    let finished = false;
    let winnerId = '';
    let draw = false;

    // 上限保护：绝不超过棋盘格子数（防御性，避免任何死循环）
    const maxFlips = st.game.size * st.game.size;
    for (let guard = 0; guard < maxFlips; guard++) {
        const seat = st.room.seats.find(function (s) {
            return s.playerId === currentPlayerId;
        });
        if (!seat || !seat.isAI) {
            break; // 轮到真人（联机路径）或找不到座位
        }

        const state = {
            size: st.game.size,
            cells: st.game.cells,
            revealed: revealMatrixToBool(st.revealed, st.game.size),
        };
        const rng = makeRng((st.game.seed || 0) + headsFound * 104729 + out.length);
        const decision = planeHuntDecide(state, rng);
        if (!decision) {
            break; // 无可用格
        }

        const key = decision.row + ',' + decision.col;
        if (st.revealed[key]) {
            break; // 理论上不会发生；防御性退出
        }

        const cell = st.game.cells[decision.row][decision.col];
        const planeIndex = findPlaneIndex(st.game, decision.row, decision.col);
        st.revealed[key] = {
            cell: cell,
            byPlayerId: seat.playerId,
            planeIndex: planeIndex,
            at: Date.now(),
            byAI: true,
        };
        st.scores[seat.playerId] = st.scores[seat.playerId] || 0;
        st.moves[seat.playerId] = (st.moves[seat.playerId] || 0) + 1;

        const scored = cell === 2;
        if (scored) {
            st.scores[seat.playerId] += 1;
            headsFound += 1;
        }

        finished = headsFound >= (st.game.heads || []).length;

        // 回合交接：与人类那一手同规则 —— **一律换手**，不再「翻中机头连翻」。
        // （同 `extraTurn` 的修正：旧规则会让 AI 翻中机头后继续翻，
        //   人类要多等一轮；且与客户端「翻到机头也换手」的规则不合。）
        if (finished) {
            const result = judge(st.scores);
            winnerId = result.winnerId;
            draw = result.draw;
        }
        currentPlayerId = finished ? seat.playerId : st.room.seats[0].playerId;

        out.push({
            row: decision.row,
            col: decision.col,
            cell: cell,
            scored: scored,
            playerId: seat.playerId,
            planeIndex: planeIndex,
            headsFound: headsFound,
            nextPlayerId: currentPlayerId,
            finished: finished,
            winnerId: winnerId,
            draw: draw,
        });

        // AI 一手即结束本回合：交回人类（或对局已结束）
        break;
    }

    if (out.length === 0) {
        return out;
    }

    const last = out[out.length - 1];
    // AI 的每一格都要追加进 flips（客户端按数组长度增量派发），
    // 否则人类界面收不到 AI 翻格、会卡在「对手思考中」。
    // 起点用调用方传入的 flips（已含人类那一手），不能读 st.game.flips 旧快照。
    let flips = Array.isArray(st.flips) ? st.flips.slice() : [];
    for (const f of out) {
        flips = appendFlip(flips, {
            row: f.row,
            col: f.col,
            cell: f.cell,
            scored: f.scored,
            playerId: f.playerId,
            planeIndex: f.planeIndex,
            byAI: true,
        });
    }

    await ctx.db.collection(st.colName).doc(st.gameDocId).update({
        data: {
            revealed: st.revealed,
            scores: st.scores,
            moves: st.moves,
            headsFound: last.headsFound,
            currentPlayerId: last.nextPlayerId,
            finished: last.finished,
            winnerId: last.winnerId,
            draw: last.draw,
            flips: flips,
            updatedAt: Date.now(),
        },
    });
    return out;
}

/**
 * 追加一条翻格记录（返回新数组）。
 *
 * 为什么单独抽出来：人类那手与 AI 的每一格都要走同一套追加逻辑，
 * 保证客户端看到的增量序列完整、顺序一致（漏一条客户端就会少显示一格）。
 */
function appendFlip(existing, item) {
    const arr = Array.isArray(existing) ? existing.slice() : [];
    arr.push(item);
    return arr;
}

/**
 * 把 revealed 的「稀疏对象」形态转成 AI 需要的二维布尔矩阵。
 *
 * 玩法数据存的是 { "r,c": {...} } 稀疏对象（见 planehunt_flip 的幂等分支），
 * 而 AI 是按二维矩阵遍历的 —— 这里做形态适配，避免为了 AI 改动权威存储结构。
 */
function revealMatrixToBool(revealed, size) {
    const m = [];
    for (let r = 0; r < size; r++) {
        const row = [];
        for (let c = 0; c < size; c++) {
            row.push(!!revealed[r + ',' + c]);
        }
        m.push(row);
    }
    return m;
}

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
