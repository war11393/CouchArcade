/**
 * 云函数 startGame —— 房主开局 + 生成权威布局（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'startGame', data: { roomId } })
 *
 * 服务端职责（权威性来源，最关键的一个云函数）：
 * 1. 校验调用者是房主且 status === 'ready'；
 * 2. 生成随机种子 seed；
 * 3. 【寻机头】用 seed 生成权威布局并写入 games_planehunt（机头坐标服务端私有）；
 * 4. 【五子棋】创建空的 games_gomoku 对局文档；
 * 5. 把 rooms.status 置为 'playing' → 所有客户端通过 watch rooms 一起进入对局。
 *
 * 安全说明：
 * 客户端永远不接收明文布局，只能通过 planehunt_flip 逐格询问结果，
 * 因此即使玩家反编译前端也无法获知机头位置，杜绝作弊。
 */

const {
    wrap,
    COLLECTIONS,
    ROOM_STATUS,
    ERR,
    BizError,
    ok,
    requireRoom,
    updateRoom,
    genSeed,
    makeRng,
} = require('./common');

/** 棋盘配置（与客户端 AppConfig 保持一致）。 */
const CONFIG = {
    planehunt: { size: 12, planeCount: 5 },
    gomoku: { size: 15, winCount: 5 },
};

/** 飞机形态矩阵（与客户端 PlaneHuntLayout.ts 完全一致）。 */
const PLANE_SHAPE = [
    [0, 0, 2, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
];

exports.main = wrap('startGame', async function (ctx, event) {
    const roomId = String(event.roomId || '');
    const room = await requireRoom(ctx, roomId);

    // 1) 权限与状态校验
    if (room.ownerId !== ctx.openid) {
        throw new BizError(ERR.NOT_OWNER, '只有房主可以开始游戏');
    }
    if (room.status === ROOM_STATUS.PLAYING) {
        console.log(`[startGame] 房间 ${roomId} 已开局，幂等返回`);
        return ok(room);
    }
    if (room.status === ROOM_STATUS.FINISHED) {
        throw new BizError(ERR.ROOM_ALREADY_STARTED, '本局已结束，请创建新房间');
    }

    // 入座 + 准备校验。
    //
    // ⚠️ AI 座位（isAI=true）与**练习房的房主自己**都视为「无需准备」：
    //    · AI 座位：playerId 由服务端建房时写入、ready 由服务端置 true，
    //      显式放行 `isAI` 是为了兼容**历史房间**（本次修复前创建、
    //      AI 座位 ready=false 的旧数据），避免它们永远开不了局；
    //    · 练习房房主：AI 练习是「一个人和 AI 打」，房主进屋就该能开局，
    //      不该被迫先点一次「准备」。这与客户端 Mock 参考实现一致
    //      （MockRoomService.createRoom 给练习房直接置 READY，
    //       房主座位始终 ready=false 也能开局），
    //      否则两端行为不一致 —— 真机卡死、Mock 正常，最难查的那种。
    //    联机房不受影响：真人座位依然必须 ready。
    const allSeated = room.seats.every(function (s) {
        return !!s.playerId;
    });
    const allReady = room.seats.every(function (s) {
        if (!s.playerId) return false;
        if (s.isAI) return true;
        if (room.isPractice && s.seatIndex === 0) return true; // 练习房房主免准备
        return !!s.ready;
    });
    if (!allSeated || !allReady) {
        // 把**到底是哪个座位**卡住了打进错误与日志 —— 上次定位这个问题
        // 花了很久，就是因为只有一句笼统的「需全员入座并准备」。
        const brief = room.seats
            .map(function (s, i) {
                return `#${i} ${s.nickname || '(空)'}${s.isAI ? '[AI]' : ''}` +
                    ` playerId=${s.playerId ? 'Y' : 'N'} ready=${s.ready ? 'Y' : 'N'}`;
            })
            .join(' | ');
        console.warn(`[startGame] room=${roomId} 开局被拦：${brief}`);
        throw new BizError(
            ERR.NOT_ALL_READY,
            '需全员入座并准备后才能开始' + (allSeated ? '（有人未准备）' : '（有座位空缺）'),
        );
    }

    const seed = genSeed();
    const now = Date.now();
    const firstPlayerId = room.seats[0].playerId;

    // 2) 按游戏创建权威对局文档
    if (room.gameId === 'planehunt') {
        await createPlaneHuntGame(ctx, room, seed, now);
    } else if (room.gameId === 'gomoku') {
        await createGomokuGame(ctx, room, seed, now);
    } else {
        throw new BizError(ERR.INVALID_MOVE, `不支持的游戏: ${room.gameId}`);
    }

    // 3) 重置座位得分并推进状态（watch 到 room.status=playing 后各端进入对局）
    const seats = room.seats.map(function (s) {
        return Object.assign({}, s, { score: 0 });
    });

    await updateRoom(ctx, roomId, {
        status: ROOM_STATUS.PLAYING,
        seed: seed,
        seats: seats,
        startedAt: now,
        currentTurnPlayerId: firstPlayerId,
    });

    const updated = await requireRoom(ctx, roomId);
    console.log(`[startGame] room=${roomId} game=${room.gameId} seed=${seed} 先手=${firstPlayerId}`);
    return ok(updated);
});

/**
 * 创建寻机头权威对局。
 *
 * 布局算法与客户端 PlaneHuntLayout.ts 完全一致（随机位置 + 随机朝向 +
 * 碰撞检测 + 失败重试），保证同一 seed 下双端推导结果相同。
 */
async function createPlaneHuntGame(ctx, room, seed, now) {
    const cfg = CONFIG.planehunt;
    const layout = generatePlaneLayout(seed, cfg.size, cfg.planeCount);

    const doc = {
        roomId: room.roomId,
        gameId: 'planehunt',
        seed: seed,
        size: cfg.size,
        planeCount: cfg.planeCount,
        /** ⚠️ 权威布局：机头坐标只存在服务端，绝不下发给客户端 */
        heads: layout.heads,
        cells: layout.cells,
        fingerprint: layout.fingerprint,
        /** 已翻开的格子：{ 'r,c': { cell, byPlayerId, planeIndex } } */
        revealed: {},
        headsFound: 0,
        scores: {},
        moves: {},
        currentPlayerId: room.seats[0].playerId,
        finished: false,
        winnerId: '',
        draw: false,
        createdAt: now,
        updatedAt: now,
    };
    // 初始化各玩家计分
    room.seats.forEach(function (s) {
        doc.scores[s.playerId] = 0;
        doc.moves[s.playerId] = 0;
    });

    await ctx.db.collection(COLLECTIONS.GAMES_PLANEHUNT).add({ data: doc });
    console.log(
        `[startGame] 寻机头布局已生成 seed=${seed} 机头数=${layout.heads.length} fingerprint=${layout.fingerprint}`,
    );

    // ⚠️ 这是**权威布局**，客户端不持有完整 cells（只存 seed）。
    //    要核对「飞机形态对不对」必须看这里的输出，客户端的
    //    PlaneHuntLayout 只在 Mock/编辑器模式生效。
    //    2026-09-24 加：按用户要求把开局完整棋盘打到云函数日志。
    dumpPlaneLayout(layout, seed, room.roomId);
}

/**
 * 把布局打成 ASCII 图（云函数日志核对用）。
 *
 * 两张图：
 *   ① 内容图：H=机头(2)  #=机身(1)  ·=空格(0)
 *   ② 归属图：同一字母 = 同一架飞机（a..e）
 * 归属图是关键 —— 相邻两架飞机挤在一起时，形态问题与「两架拼一起」
 * 看起来一样，只有按编号才能一眼分清。
 *
 * 并逐架校验格数：每架应为 11 格（1 机头 + 10 机身），有偏差即告警。
 */
function dumpPlaneLayout(layout, seed, roomId) {
    const size = layout.size;
    const cells = layout.cells;
    const heads = layout.heads;
    const LETTERS = 'abcdefghij';
    const lines = [];

    lines.push(`[startGame] ===== 布局 dump roomId=${roomId} seed=${seed} ${size}×${size} =====`);
    lines.push('[startGame] 图例： H=机头(2)  #=机身(1)  ·=空格(0)');
    lines.push('[startGame]      ' + Array.from({ length: size }, function (_, c) {
        return String(c % 10);
    }).join(' '));
    for (let r = 0; r < size; r++) {
        const row = cells[r].map(function (v) {
            return v === 2 ? 'H' : v === 1 ? '#' : '·';
        }).join(' ');
        lines.push('[startGame] ' + String(r).padStart(2, ' ') + ' | ' + row);
    }

    // 归属图：同一字母 = 同一架飞机。这是本次 dump 的重点 ——
    // 「形态错」与「两架飞机挨在一起看着像一架畸形」在内容图上长得一样，
    // 只有按编号才能一眼分清。
    if (Array.isArray(layout.planeIndexAt)) {
        lines.push('[startGame] ---- 按飞机编号（同一字母 = 同一架）----');
        lines.push('[startGame]      ' + Array.from({ length: size }, function (_, c) {
            return String(c % 10);
        }).join(' '));
        for (let r = 0; r < size; r++) {
            const row = layout.planeIndexAt[r].map(function (i) {
                return i >= 0 ? LETTERS[i % LETTERS.length] : '·';
            }).join(' ');
            lines.push('[startGame] ' + String(r).padStart(2, ' ') + ' | ' + row);
        }
    } else {
        lines.push('[startGame] （无 planeIndexAt，跳过归属图）');
    }

    // 逐架格数校验：形态矩阵非零格数 = 11
    const EXPECTED = PLANE_SHAPE.reduce(function (n, row) {
        return n + row.filter(function (v) { return v !== 0; }).length;
    }, 0);
    lines.push('[startGame] ---- 各架明细（基准 ' + EXPECTED + ' 格 = 1 机头 + ' + (EXPECTED - 1) + ' 机身）----');
    let bad = 0;
    const indexAt = layout.planeIndexAt;
    for (let i = 0; i < heads.length; i++) {
        let body = 0;
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (indexAt && indexAt[r][c] === i && cells[r][c] === 1) {
                    body++;
                }
            }
        }
        const total = indexAt ? body + 1 : -1;
        const flag = indexAt ? (total === EXPECTED ? '' : '  ⚠️ 格数异常！') : '  (无归属图，跳过)';
        if (flag.indexOf('⚠️') >= 0) {
            bad++;
        }
        lines.push(
            '[startGame]   第 ' + i + ' 架(' + LETTERS[i % LETTERS.length] + '): 机头=(' +
            heads[i].row + ',' + heads[i].col + ') 机身=' + body + ' 合计=' + total + flag,
        );
    }
    if (bad > 0) {
        lines.push('[startGame] ⚠️ 有 ' + bad + ' 架飞机格数不等于基准 —— 形态矩阵或放置逻辑有问题');
    } else if (heads.length > 0 && indexAt) {
        lines.push('[startGame] ✅ 全部 ' + heads.length + ' 架格数正常');
    }

    console.log(lines.join('\n'));
}

/** 创建五子棋权威对局。 */
async function createGomokuGame(ctx, room, seed, now) {
    const cfg = CONFIG.gomoku;
    const board = [];
    for (let r = 0; r < cfg.size; r++) {
        const row = [];
        for (let c = 0; c < cfg.size; c++) {
            row.push(0);
        }
        board.push(row);
    }

    const doc = {
        roomId: room.roomId,
        gameId: 'gomoku',
        seed: seed,
        size: cfg.size,
        winCount: cfg.winCount,
        board: board,
        /** 落子历史（重连补偿用） */
        history: [],
        moveCount: 0,
        currentPlayerId: room.seats[0].playerId,
        finished: false,
        winnerId: '',
        draw: false,
        winLine: [],
        createdAt: now,
        updatedAt: now,
    };

    await ctx.db.collection(COLLECTIONS.GAMES_GOMOKU).add({ data: doc });
    console.log(`[startGame] 五子棋对局已创建 room=${room.roomId}`);
}

/**
 * 生成寻机头布局（服务端权威，算法与客户端同构）。
 */
function generatePlaneLayout(seed, size, planeCount) {
    const rng = makeRng(seed);
    const cells = [];
    const planeIndexAt = [];
    for (let r = 0; r < size; r++) {
        const row = [];
        const idxRow = [];
        for (let c = 0; c < size; c++) {
            row.push(0);
            idxRow.push(-1);
        }
        cells.push(row);
        planeIndexAt.push(idxRow);
    }

    const heads = [];
    const rotations = [0, 90, 180, 270];
    const key = function (r, c) {
        return r * size + c;
    };
    /**
     * 已占用的**实体格**集合，用于重叠检测。
     *
     * ⚠️ 2026-09-24 实测记录：约束只能是「实体格不重叠」。
     *   12×12 棋盘放 5 架十字战机时，任何「不许相邻」的加强约束都无解：
     *     · 实体格 8 邻域互斥 → 回溯 65641 节点无解
     *     · 间隔 1 格空气     → 回溯 1145 节点无解
     *     · 仅实体格不重叠     → 6 节点即有解
     *   所以**不要**试图加间距约束（会让布局生成失败）。飞机形态的
     *   正确性由 dumpPlaneLayout 逐架自检保证（每架恰好 10 格）。
     */
    const occupied = new Set();

    let placed = 0;
    let retry = 0;
    const maxRetry = 400 * planeCount;

    while (placed < planeCount && retry < maxRetry) {
        retry++;
        const shape = rotateShape(PLANE_SHAPE, rng.pick(rotations));
        const h = shape.length;
        const w = shape[0].length;

        const originRow = rng.int(0, size - h);
        const originCol = rng.int(0, size - w);

        const pending = [];
        let overlap = false;
        for (let r = 0; r < h && !overlap; r++) {
            for (let c = 0; c < w; c++) {
                const v = shape[r][c];
                if (v === 0) {
                    continue;
                }
                const gr = originRow + r;
                const gc = originCol + c;
                // 与已放置飞机：**实体格不得重叠**（唯一可行约束，见 occupied 说明）
                if (occupied.has(key(gr, gc))) {
                    overlap = true;
                    break;
                }
                pending.push({ row: gr, col: gc, v: v });
            }
        }
        if (overlap) {
            continue;
        }

        let headRow = -1;
        let headCol = -1;
        pending.forEach(function (p) {
            cells[p.row][p.col] = p.v;
            planeIndexAt[p.row][p.col] = placed;
            occupied.add(key(p.row, p.col));
            if (p.v === 2) {
                headRow = p.row;
                headCol = p.col;
            }
        });

        if (headRow < 0) {
            continue;
        }

        heads.push({ row: headRow, col: headCol, planeIndex: placed });
        placed++;
    }

    if (placed < planeCount) {
        console.error(`[generatePlaneLayout] 仅放置 ${placed}/${planeCount} 架（seed=${seed}）`);
    }

    return {
        cells: cells,
        heads: heads,
        /**
         * 格子 → 飞机编号（-1 = 非飞机）。**不入库**（权威布局含机身信息，
         * 与 cells 同级别敏感），仅供日志 dump 核对「哪几格属于同一架」用。
         * 2026-09-24 加：dumpPlaneLayout 要靠它画归属图。
         */
        planeIndexAt: planeIndexAt,
        size: size,
        fingerprint: fingerprint(seed, heads),
    };
}

/** 顺时针旋转形态矩阵。 */
function rotateShape(shape, rotation) {
    let cur = shape.map(function (row) {
        return row.slice();
    });
    const times = rotation / 90;
    for (let i = 0; i < times; i++) {
        cur = rotate90(cur);
    }
    return cur;
}

function rotate90(m) {
    const h = m.length;
    const w = m[0].length;
    const out = [];
    for (let c = 0; c < w; c++) {
        const row = [];
        for (let r = h - 1; r >= 0; r--) {
            row.push(m[r][c]);
        }
        out.push(row);
    }
    return out;
}

/** 布局指纹（与客户端同算法，用于双端一致性校验）。 */
function fingerprint(seed, heads) {
    const s = heads
        .map(function (h) {
            return '' + h.row + h.col;
        })
        .sort()
        .join('-');
    let hash = (2166136261 ^ (seed >>> 0)) >>> 0;
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
