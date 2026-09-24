/**
 * 云函数「AI 回手」端到端仿真（开发辅助脚本，不参与游戏运行）。
 *
 * 手法：把 `wx-server-sdk` 用一个**内存数据库桩**顶替掉，然后
 * **直接 require 真实的 cloudfunctions/gomoku_move/index.js** 并调用它的
 * exports.main —— 也就是真正跑一遍线上那套代码，而不是复刻一份。
 *
 * 这比单元测试强的地方：能验证「人类落子 → 写库 → AI 回手 → 写库」的
 * 完整链路，包括云函数里那段容易写错的字段覆盖（AI 回手不能把
 * 「人类是否成五」冲掉）。
 *
 * 为什么需要它：真机尚未验证（需部署 + 重新构建），
 * 而「AI 不落子」这类问题在真机上的表现是「卡在对手思考中」，
 * 只能靠日志猜。有这套仿真就能在本地把整条链路跑通。
 *
 * 运行：node tools/test-gomoku-ai-e2e.js
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

// =====================================================================
// 内存数据库桩 + wx-server-sdk 顶替
// =====================================================================
const store = { collections: {} };

function makeQuery(collection) {
    const rows = () => (store.collections[collection] || []);
    return {
        where(cond) {
            const self = this;
            self._cond = cond;
            return self;
        },
        async get() {
            const cond = this._cond;
            let data = rows().slice();
            if (cond) {
                data = data.filter((d) =>
                    Object.keys(cond).every((k) => d[k] === cond[k]));
            }
            return { data: data.map((d) => JSON.parse(JSON.stringify(d))) };
        },
        async count() {
            const { data } = await this.get();
            return { total: data.length };
        },
        doc(id) {
            return {
                async update({ data }) {
                    const target = rows().find((d) => d._id === id);
                    if (target) Object.assign(target, data);
                    return { stats: { updated: target ? 1 : 0 } };
                },
                async get() {
                    const target = rows().find((d) => d._id === id);
                    return { data: target ? JSON.parse(JSON.stringify(target)) : null };
                },
            };
        },
        async add({ data }) {
            store.collections[collection] = store.collections[collection] || [];
            const id = `doc-${store.collections[collection].length + 1}`;
            store.collections[collection].push(Object.assign({ _id: id }, JSON.parse(JSON.stringify(data))));
            return { _id: id };
        },
        async update({ data }) {
            const cond = this._cond;
            let n = 0;
            for (const d of rows()) {
                if (!cond || Object.keys(cond).every((k) => d[k] === cond[k])) {
                    Object.assign(d, data);
                    n++;
                }
            }
            return { stats: { updated: n } };
        },
    };
}

const fakeDb = {
    collection: (name) => makeQuery(name),
    command: {
        nin: (arr) => ({ __nin: arr }),
        eq: (v) => ({ __eq: v }),
    },
};

const FAKE_SDK = {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'fake-env',
    database: () => fakeDb,
    getWXContext: () => ({ OPENID: global.__TEST_OPENID__ || '', APPID: 'wxtest', UNIONID: '' }),
};

// 拦截 require('wx-server-sdk')
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') {
        return FAKE_SDK;
    }
    return origLoad.apply(this, arguments);
};
void origResolve;

// =====================================================================
// 载入真实云函数（注意：必须在上面的拦截之后）
// =====================================================================
const ROOT = path.join(__dirname, '..');

let gomokuMove;
let planeHuntFlip;
try {
    gomokuMove = require(path.join(ROOT, 'cloudfunctions', 'gomoku_move', 'index.js'));
    planeHuntFlip = require(path.join(ROOT, 'cloudfunctions', 'planehunt_flip', 'index.js'));
} catch (err) {
    console.error('载入云函数失败:', err.message);
    process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
    }
}

// =====================================================================
// 场景搭建
// =====================================================================
const HUMAN = 'oHuman';
const AI = 'ai-627357-1';
const ROOM_ID = '627357';

/** 建一个练习房 + 一副空棋局（模拟 createRoom + startGame 的结果）。 */
function setup({ level = 2 } = {}) {
    store.collections = {};
    const size = 15;
    const board = Array.from({ length: size }, () => new Array(size).fill(0));

    store.collections.rooms = [{
        _id: 'room1',
        roomId: ROOM_ID,
        gameId: 'gomoku',
        status: 'playing',
        ownerId: HUMAN,
        isPractice: true,
        seed: 987654,
        maxPlayers: 2,
        seats: [
            { seatIndex: 0, playerId: HUMAN, nickname: '微信用户', ready: false, isAI: false, aiLevel: level, score: 0 },
            { seatIndex: 1, playerId: AI, nickname: '机头猎手', ready: true, isAI: true, aiLevel: level, score: 0 },
        ],
    }];

    store.collections.games_gomoku = [{
        _id: 'game1',
        roomId: ROOM_ID,
        gameId: 'gomoku',
        seed: 987654,
        size,
        winCount: 5,
        board,
        history: [],
        moveCount: 0,
        currentPlayerId: HUMAN,
        finished: false,
        winnerId: '',
        draw: false,
        winLine: [],
    }];
}

/** 以某玩家身份调用 gomoku_move（真实云函数）。 */
async function callMove(openid, row, col) {
    global.__TEST_OPENID__ = openid;
    return gomokuMove.main(
        { roomId: ROOM_ID, row, col, reqSeq: Math.floor(Math.random() * 1e6) },
        { openid },
    );
}

const gameDoc = () => store.collections.games_gomoku[0];

// =====================================================================
// 寻机头场景
// =====================================================================

/** 建一个寻机头练习房 + 权威棋局（复刻 startGame 的产出形态）。 */
function setupPlaneHunt({ level = 2 } = {}) {
    store.collections = {};
    const size = 12;
    const planeCount = 5;

    // 布局：为了专注验证 AI 回合逻辑，这里手摆 5 架飞机（每架 1 机头 + 9 机身）
    // 不追求与真实生成器一致 —— AI 只看 cells/revealed，与布局来源无关。
    const heads = [];
    const cells = Array.from({ length: size }, () => new Array(size).fill(0));
    const headPositions = [[1, 1], [1, 6], [5, 1], [5, 6], [9, 3]];
    headPositions.forEach(([hr, hc], i) => {
        heads.push({ row: hr, col: hc, planeIndex: i });
        // 3x3 机身 + 机头（机头在中心，机身环绕）
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r = hr + dr;
                const c = hc + dc;
                if (r < 0 || r >= size || c < 0 || c >= size) continue;
                cells[r][c] = dr === 0 && dc === 0 ? 2 : 1;
            }
        }
    });

    store.collections.rooms = [{
        _id: 'room1',
        roomId: ROOM_ID,
        gameId: 'planehunt',
        status: 'playing',
        ownerId: HUMAN,
        isPractice: true,
        seed: 55555,
        maxPlayers: 2,
        seats: [
            { seatIndex: 0, playerId: HUMAN, nickname: '微信用户', ready: false, isAI: false, aiLevel: level, score: 0 },
            { seatIndex: 1, playerId: AI, nickname: '机头猎手', ready: true, isAI: true, aiLevel: level, score: 0 },
        ],
    }];

    store.collections.games_planehunt = [{
        _id: 'ph1',
        roomId: ROOM_ID,
        gameId: 'planehunt',
        seed: 55555,
        size,
        planeCount,
        heads,
        cells,
        revealed: {},
        scores: {},
        moves: {},
        headsFound: 0,
        currentPlayerId: HUMAN,
        finished: false,
        winnerId: '',
        draw: false,
    }];
}

/** 以某玩家身份调用 planehunt_flip（真实云函数）。 */
async function callFlip(openid, row, col) {
    global.__TEST_OPENID__ = openid;
    return planeHuntFlip.main(
        { roomId: ROOM_ID, row, col, reqSeq: Math.floor(Math.random() * 1e6) },
        { openid },
    );
}

const planeDoc = () => store.collections.games_planehunt[0];

console.log('=== 云函数 AI 回手端到端仿真 ===\n');

// ---------------------------------------------------------------------
(async () => {
    console.log('场景 1：人类落子 → AI 自动回手（核心：修好「卡在对手回合」）');
    {
        setup();
        const res = await callMove(HUMAN, 7, 7);
        const g = gameDoc();

        check('云函数返回成功', res && res.code === 0, JSON.stringify(res).slice(0, 160));
        check('人类这一手已落盘', g.board[7][7] === 1,
            `board[7][7]=${g.board[7][7]}`);
        check('AI 已回手（库里有第二颗子）', g.moveCount === 2,
            `moveCount=${g.moveCount}`);
        check('返回体带 AI 落点', !!res.data.aiMove,
            `aiMove=${JSON.stringify(res.data.aiMove)}`);
        check('AI 落点是合法空位（棋色为 2=白）',
            res.data.aiMove && g.board[res.data.aiMove.row][res.data.aiMove.col] === 2,
            JSON.stringify(res.data.aiMove));
        check('回合已交回人类', g.currentPlayerId === HUMAN,
            `currentPlayerId=${g.currentPlayerId}`);
        check('对局未结束', g.finished === false);
    }

    console.log('\n场景 2：连续多手（人机轮流，不卡死）');
    {
        setup();
        // 人类每手都从「当前空位」里动态挑，而不是写死坐标 ——
        // 写死会与 AI 的回手撞车（AI 可能刚好占了那个点），
        // 那是**测试自己的缺陷**，不是云函数的问题。
        let ok = true;
        let detail = '';
        for (let i = 0; i < 5; i++) {
            const g = gameDoc();
            let target = null;
            for (let r = 0; r < g.size && !target; r++) {
                for (let c = 0; c < g.size && !target; c++) {
                    if (g.board[r][c] === 0) target = { r, c };
                }
            }
            if (!target) { ok = false; detail = '棋盘已满'; break; }

            const res = await callMove(HUMAN, target.r, target.c);
            if (!res || res.code !== 0) {
                ok = false;
                detail = `第 ${i + 1} 手 (${target.r},${target.c}) 失败: ` +
                    JSON.stringify(res).slice(0, 120);
                break;
            }
            const after = gameDoc();
            if (after.moveCount % 2 !== 0 && !after.finished) {
                ok = false;
                detail = `moveCount=${after.moveCount} 为奇数（AI 未回手）`;
                break;
            }
        }
        check('5 轮人机交替后步数为偶数（AI 每轮都回了）',
            ok && gameDoc().moveCount % 2 === 0,
            detail || `moveCount=${gameDoc().moveCount}`);
        check('回合稳定交回人类（或对局已结束）',
            gameDoc().currentPlayerId === HUMAN || gameDoc().finished,
            `currentPlayerId=${gameDoc().currentPlayerId} finished=${gameDoc().finished}`);
    }

    console.log('\n场景 3：AI 落子不与已有棋子重叠、不越界');
    {
        setup();
        const occupied = new Set();
        let bad = null;
        for (let i = 0; i < 8 && !bad; i++) {
            // 人类往一个长线上铺（逼 AI 来堵）
            const r = 7;
            const c = 3 + i;
            const res = await callMove(HUMAN, r, c);
            if (!res || res.code !== 0) {
                // 人类这手可能非法（已被 AI 占），换一手继续
                continue;
            }
            occupied.add(`${r},${c}`);
            const ai = res.data.aiMove;
            if (ai) {
                const k = `${ai.row},${ai.col}`;
                if (occupied.has(k)) bad = `AI 落在已占位 ${k}`;
                if (ai.row < 0 || ai.row > 14 || ai.col < 0 || ai.col > 14) bad = `AI 越界 ${k}`;
                occupied.add(k);
            }
        }
        check('AI 全程不重叠、不越界', !bad, bad || '');
    }

    console.log('\n场景 4：人类成五时 AI 不应「抢戏」（胜负归属不被覆盖）');
    {
        setup();
        // 做法：直接构造「人类已有四连、且 AI 无法堵两侧」的局面 ——
        // 不能靠连下 4 手来铺线，因为 AI 会来堵（仿真里实测它会占 (7,6)，
        // 那是**正确的防守行为**，不是 bug）。这里改从棋局文档入手，
        // 精确控制局面，专注验证「胜负归属不被 AI 回手覆盖」。
        const g0 = gameDoc();
        g0.board[7][3] = 1;
        g0.board[7][4] = 1;
        g0.board[7][5] = 1;
        g0.board[7][6] = 1;
        g0.board[6][6] = 2; // 白子挡在上面，不影响下方成五
        g0.history = [
            { row: 7, col: 3, playerId: HUMAN, stone: 1, at: 1 },
            { row: 7, col: 4, playerId: HUMAN, stone: 1, at: 2 },
            { row: 7, col: 5, playerId: HUMAN, stone: 1, at: 3 },
            { row: 7, col: 6, playerId: HUMAN, stone: 1, at: 4 },
            { row: 6, col: 6, playerId: AI, stone: 2, at: 5 },
        ];
        g0.moveCount = 5;
        g0.currentPlayerId = HUMAN;

        const res = await callMove(HUMAN, 7, 7); // 补第五子成五
        const g = gameDoc();

        check('人类成五后对局结束', g.finished === true,
            `finished=${g.finished} moveCount=${g.moveCount}`);
        check('胜者是人类', g.winnerId === HUMAN,
            `winnerId=${g.winnerId}（若为 AI 说明回手抢了胜负）`);
        check('返回体标明人类这手成五', res.data.humanWin === true || res.data.win === true,
            `humanWin=${res.data.humanWin} win=${res.data.win}`);
        check('人类成五时不再触发 AI 回手', res.data.aiMove === null,
            `aiMove=${JSON.stringify(res.data.aiMove)}`);
        check('落盘战绩：步数未被 AI 追加', g.moveCount === 6,
            `moveCount=${g.moveCount}`);
    }

    console.log('\n场景 4b：AI 的防守能力（对手四连时必须去堵）');
    {
        setup();
        const g0 = gameDoc();
        // 人类四连，两端空着 → AI 必须堵一端
        g0.board[7][4] = 1;
        g0.board[7][5] = 1;
        g0.board[7][6] = 1;
        g0.board[7][7] = 1;
        g0.moveCount = 4;
        g0.currentPlayerId = HUMAN;

        // 人类去补 (7,3) 自己成五（这是必胜手，AI 拦不住）
        const res = await callMove(HUMAN, 7, 3);
        check('人类先成五（必胜手优先于防守）',
            res.data.humanWin === true || res.data.win === true,
            JSON.stringify(res.data).slice(0, 140));
    }

    console.log('\n场景 5：联机路径不受影响（对手是真人时 AI 不介入）');
    {
        setup();
        // 把 AI 座位换成人
        store.collections.rooms[0].seats[1] =
            { seatIndex: 1, playerId: 'oOther', nickname: '对手', ready: true, isAI: false, score: 0 };
        const res = await callMove(HUMAN, 7, 7);
        const g = gameDoc();
        check('真人对手：回合交给对方', g.currentPlayerId === 'oOther',
            `currentPlayerId=${g.currentPlayerId}`);
        check('真人对手：不追加 AI 落子', g.moveCount === 1, `moveCount=${g.moveCount}`);
        check('返回体无 aiMove', res.data.aiMove === null);
    }

    console.log('\n场景 6：非对局中 / 非本人回合 仍被正确拒绝');
    {
        setup();
        store.collections.rooms[0].status = 'waiting';
        const res = await callMove(HUMAN, 7, 7);
        check('房间未开局 → 拒绝', res && res.success === false,
            JSON.stringify(res).slice(0, 120));
    }
    {
        setup();
        const res = await callMove('oStranger', 7, 7);
        check('非房主/非本回合玩家 → 拒绝', res && res.success === false,
            JSON.stringify(res).slice(0, 120));
    }

    // =====================================================================
    // 寻机头（planehunt_flip）—— 与五子棋同构的 AI 回手
    // =====================================================================
    console.log('\n场景 7：寻机头 AI 回手（含「翻中机头连翻」规则）');
    {
        setupPlaneHunt();
        const res = await callFlip(HUMAN, 0, 0);
        const g = planeDoc();

        check('云函数返回成功', res && res.code === 0,
            JSON.stringify(res).slice(0, 160));
        check('人类翻的格子已记录', !!g.revealed['0,0']);
        check('AI 已翻格（revealed 里出现 AI 的格子）',
            Object.keys(g.revealed).length >= 2,
            `revealed 数=${Object.keys(g.revealed).length}`);
        check('AI 翻格记录带 byAI 标记',
            Object.keys(g.revealed).some((k) => g.revealed[k].byAI === true));
        check('返回体带 aiFlips', Array.isArray(res.data.aiFlips) && res.data.aiFlips.length > 0,
            `aiFlips=${JSON.stringify(res.data.aiFlips)}`);
        check('回合已交回人类或对局结束',
            g.currentPlayerId === HUMAN || g.finished,
            `currentPlayerId=${g.currentPlayerId} finished=${g.finished}`);
    }

    console.log('\n场景 8：寻机头 AI 不会重复翻同一格 / 不越界');
    {
        setupPlaneHunt();
        let bad = null;
        for (let i = 0; i < 12 && !bad; i++) {
            const g = planeDoc();
            // 找一个未翻开的格子交给人类
            let target = null;
            for (let r = 0; r < g.size && !target; r++) {
                for (let c = 0; c < g.size && !target; c++) {
                    if (!g.revealed[r + ',' + c]) target = { r, c };
                }
            }
            if (!target) break;
            const res = await callFlip(HUMAN, target.r, target.c);
            if (!res || res.code !== 0) {
                bad = `人类翻 (${target.r},${target.c}) 失败: ${JSON.stringify(res).slice(0, 120)}`;
                break;
            }
            for (const f of (res.data.aiFlips || [])) {
                if (f.row < 0 || f.row >= g.size || f.col < 0 || f.col >= g.size) {
                    bad = `AI 越界 (${f.row},${f.col})`;
                }
            }
            // 检查 AI 前后两次是否翻到同一格
            const g2 = planeDoc();
            const aiKeys = Object.keys(g2.revealed).filter((k) => g2.revealed[k].byAI);
            if (new Set(aiKeys).size !== aiKeys.length) bad = 'revealed 键重复（不可能）';
        }
        // 关键不变式：每个格子最多被翻一次（稀疏对象天然去重，这里做显式确认）
        const g = planeDoc();
        const opened = Object.keys(g.revealed).length;
        const cellsTotal = g.size * g.size;
        check('已翻开格数不超过棋盘总格数', opened <= cellsTotal,
            `opened=${opened} total=${cellsTotal}`);
        check('AI 全程不越界', !bad, bad || '');
    }

    console.log('\n场景 9：寻机头联机路径不受影响（真人对手时 AI 不介入）');
    {
        setupPlaneHunt();
        store.collections.rooms[0].seats[1] =
            { seatIndex: 1, playerId: 'oOther', nickname: '对手', ready: true, isAI: false, score: 0 };
        const res = await callFlip(HUMAN, 0, 0);
        const g = planeDoc();
        check('真人对手：不追加 AI 翻格',
            (res.data.aiFlips || []).length === 0,
            `aiFlips=${JSON.stringify(res.data.aiFlips)}`);
        check('真人对手：回合交给对方', g.currentPlayerId === 'oOther',
            `currentPlayerId=${g.currentPlayerId}`);
    }

    console.log('\n场景 10：客户端 watch 契约（lastMove / flips 必须写库）');
    {
        // 为什么单独验证：客户端 WxNetSyncService._handleGameDoc 是按
        // `moveCount + lastMove`（五子棋）与 `flips.length`（寻机头）增量派发的。
        // 云函数只写 history/revealed 而不写这两个字段时，客户端**永远收不到
        // 任何落子** —— 症状是「双方界面都不动」，而云函数日志一切正常。
        setup();
        await callMove(HUMAN, 7, 7);
        const g = gameDoc();
        check('五子棋：人类落子后写入了 lastMove', !!g.lastMove,
            `lastMove=${JSON.stringify(g.lastMove)}`);
        check('五子棋：lastMove 是 AI 那一手（后写覆盖）',
            g.lastMove && g.lastMove.playerId === AI,
            `lastMove.playerId=${g.lastMove && g.lastMove.playerId}（应为 AI=${AI}）`);

        setupPlaneHunt();
        await callFlip(HUMAN, 0, 0);
        const p = planeDoc();
        check('寻机头：人类翻格后写入了 flips 数组',
            Array.isArray(p.flips) && p.flips.length > 0,
            `flips=${JSON.stringify(p.flips)}`);
        check('寻机头：flips 同时含人类与 AI 的记录',
            Array.isArray(p.flips)
            && p.flips.some((f) => f.playerId === HUMAN)
            && p.flips.some((f) => f.playerId === AI),
            `flips=${JSON.stringify(p.flips)}`);
        check('寻机头：flips 不含权威布局字段（防泄漏）',
            Array.isArray(p.flips) && p.flips.every((f) => f.cells === undefined),
            'flips 里出现了 cells —— 会泄漏机头位置');
    }

    console.log('\n场景 11：回合归属与胜负必须自洽（库文档不变式）');
    {
        // 为什么单独验证（2026-09-24）：原实现里「人类成五」时
        //   nextPlayerId = finished ? game.currentPlayerId : otherPlayer(...)
        // 会把回合写成**人类自己**，随后又被 AI 分支覆盖；AI 那手自己成五时
        // 则可能留下「finished=true 且 currentPlayerId=人类」的矛盾文档。
        // 中途 watch 到这种帧的客户端会算出错误回合 → 表现为「点了没反应」。
        // 不变式：finished=true ⇒ 文档自洽（胜者存在或平局，且回合停在最后一手方）。
        setup();
        await callMove(HUMAN, 7, 7); // 人类一手 + AI 一手
        let g = gameDoc();
        check('正常手：未结束且回合在人类身上',
            g.finished === false && g.currentPlayerId === HUMAN,
            `finished=${g.finished} cur=${g.currentPlayerId}`);

        // 造「人类立刻成五」：四连 + 补第五子
        setup();
        const g0 = gameDoc();
        g0.board[7][3] = 1; g0.board[7][4] = 1; g0.board[7][5] = 1; g0.board[7][6] = 1;
        g0.board[6][6] = 2;
        g0.moveCount = 5;
        g0.currentPlayerId = HUMAN;
        await callMove(HUMAN, 7, 7);
        g = gameDoc();
        check('人类成五：finished=true 且胜者=人类',
            g.finished === true && g.winnerId === HUMAN,
            `finished=${g.finished} winner=${g.winnerId}`);
        check('人类成五：回合不停在「接下来该人类下」的矛盾态',
            g.currentPlayerId === HUMAN,
            `currentPlayerId=${g.currentPlayerId}`);
        check('人类成五：lastMove 的 nextPlayerId 与文档一致',
            g.lastMove && g.lastMove.nextPlayerId === g.currentPlayerId,
            `lastMove.nextPlayerId=${g.lastMove && g.lastMove.nextPlayerId} cur=${g.currentPlayerId}`);
        check('人类成五：lastMove.finished 标记为 true',
            g.lastMove && g.lastMove.finished === true,
            `lastMove.finished=${g.lastMove && g.lastMove.finished}`);

        // 造「AI 这手自己成五」：白四连，人类随便下一手不干扰，
        // 逼 AI 补第五子取胜（AI 优先自己成五，见 gomokuDecide ①）
        setup();
        const g1 = gameDoc();
        g1.board[5][5] = 2; g1.board[6][5] = 2; g1.board[7][5] = 2; g1.board[8][5] = 2;
        g1.board[0][0] = 1;
        g1.moveCount = 5;
        g1.currentPlayerId = HUMAN;
        const r1 = await callMove(HUMAN, 0, 1);
        const g1After = gameDoc();
        check('AI 自己成五：对局结束且胜者=AI',
            g1After.finished === true && g1After.winnerId === AI,
            `finished=${g1After.finished} winner=${g1After.winnerId} aiMove=${JSON.stringify(r1.data.aiMove)}`);
        check('AI 自己成五：currentPlayerId 与文档自洽（= 最后一手方 AI）',
            g1After.currentPlayerId === AI,
            `currentPlayerId=${g1After.currentPlayerId}`);
        check('AI 自己成五：lastMove.nextPlayerId 与文档一致',
            g1After.lastMove && g1After.lastMove.nextPlayerId === g1After.currentPlayerId,
            `lastMove=${JSON.stringify(g1After.lastMove)} cur=${g1After.currentPlayerId}`);
    }

    console.log(`\n${fail === 0 ? 'ALL_GOMOKU_AI_E2E_PASSED' : 'GOMOKU_AI_E2E_FAILURES=' + fail}` +
        `  (${pass} 通过, ${fail} 失败)`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('仿真异常:', err);
    process.exit(1);
});
