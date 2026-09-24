/**
 * 寻机头回合规则一致性回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 守护的行为（2026-09-24 实测确证过的规则漂移）：
 *   云函数 `planehunt_flip` 原先是「翻中机头奖励额外一次」（extraTurn=true），
 *   而客户端 `PlaneHuntRules.ts` 早已改成「翻到机头也换手」（extraTurn 恒 false）。
 *   两端不一致的后果：人类翻中机头后服务端把回合留给自己、客户端按「一定换手」
 *   理解 → isMyTurn() 判定错位 → 真机点格子没有任何反应。
 *
 * 手法同 tools/test-gomoku-ai-e2e.js：内存库桩 + require 真实云函数。
 *
 * 运行：node tools/test-planehunt-turn.js
 */

const path = require('path');
const Module = require('module');

const store = { collections: {} };

function makeQuery(collection) {
    const rows = () => (store.collections[collection] || []);
    return {
        where(cond) { this._cond = cond; return this; },
        async get() {
            const cond = this._cond;
            let data = rows().slice();
            if (cond) data = data.filter((d) => Object.keys(cond).every((k) => d[k] === cond[k]));
            return { data: data.map((d) => JSON.parse(JSON.stringify(d))) };
        },
        async count() { const { data } = await this.get(); return { total: data.length }; },
        doc(id) {
            return {
                async update({ data }) {
                    const t = rows().find((d) => d._id === id);
                    if (t) Object.assign(t, data);
                    return { stats: { updated: t ? 1 : 0 } };
                },
                async get() {
                    const t = rows().find((d) => d._id === id);
                    return { data: t ? JSON.parse(JSON.stringify(t)) : null };
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
                if (!cond || Object.keys(cond).every((k) => d[k] === cond[k])) { Object.assign(d, data); n++; }
            }
            return { stats: { updated: n } };
        },
    };
}

const fakeDb = {
    collection: (n) => makeQuery(n),
    command: { nin: (a) => ({ __nin: a }), eq: (v) => ({ __eq: v }) },
};
const FAKE_SDK = {
    init: () => {}, DYNAMIC_CURRENT_ENV: 'fake', database: () => fakeDb,
    getWXContext: () => ({ OPENID: global.__OID || '', APPID: 'x', UNIONID: '' }),
};
const origLoad = Module._load;
Module._load = function (req) {
    if (req === 'wx-server-sdk') return FAKE_SDK;
    return origLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, '..');
const flip = require(path.join(ROOT, 'cloudfunctions', 'planehunt_flip', 'index.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const HUMAN = 'oHuman';
const OTHER = 'oOther';
const ROOM = '111222';
const SIZE = 12;

/** 摆 5 个机头（对局不会一手结束），机身用 1 填充邻域。 */
function setup({ level = 2, aiSeat = false } = {}) {
    const cells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    const heads = [];
    const headPos = [[0, 0], [0, 5], [3, 0], [3, 5], [6, 6]];
    headPos.forEach(([r, c], i) => {
        heads.push({ row: r, col: c, planeIndex: i });
        cells[r][c] = 2;
        // 给机头周围铺机身，保证「翻机身」也有的可翻
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr;
                const cc = c + dc;
                if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && cells[rr][cc] === 0) {
                    cells[rr][cc] = 1;
                }
            }
        }
    });

    const seat1 = aiSeat
        ? { seatIndex: 1, playerId: 'ai-1', nickname: '机头猎手', ready: true, isAI: true, aiLevel: level, score: 0 }
        : { seatIndex: 1, playerId: OTHER, nickname: '乙', ready: true, isAI: false, score: 0 };

    store.collections = {
        rooms: [{
            _id: 'r1', roomId: ROOM, gameId: 'planehunt', status: 'playing',
            ownerId: HUMAN, isPractice: aiSeat, seed: 999,
            seats: [
                { seatIndex: 0, playerId: HUMAN, nickname: '甲', ready: true, isAI: false, score: 0 },
                seat1,
            ],
            startedAt: Date.now(),
        }],
        games_planehunt: [{
            _id: 'g1', roomId: ROOM, gameId: 'planehunt', seed: 999,
            size: SIZE, planeCount: 5, heads, cells,
            revealed: {}, scores: { [HUMAN]: 0, [OTHER]: 0, 'ai-1': 0 },
            moves: {}, headsFound: 0,
            currentPlayerId: HUMAN, finished: false, winnerId: '', draw: false,
        }],
    };
}

async function callFlip(openid, row, col) {
    global.__OID = openid;
    return flip.main({ roomId: ROOM, row, col, reqSeq: Math.floor(Math.random() * 1e6) }, { openid });
}

const doc = () => store.collections.games_planehunt[0];

/** 找一个还没翻开的格子。 */
function firstUnrevealed(d) {
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (!d.revealed[r + ',' + c]) return { r, c };
        }
    }
    return null;
}

console.log('=== 寻机头回合规则一致性回归测试 ===\n');

(async () => {
    console.log('场景 1：人类翻中机头 → 必须换手（不再「连翻」）');
    {
        setup();
        const d0 = doc();
        d0.revealed['0,0'] = { cell: 2, byPlayerId: HUMAN, planeIndex: 0 };
        d0.headsFound = 1;
        d0.scores[HUMAN] = 1;
        d0.currentPlayerId = HUMAN;
        // 人类翻另一个机头 (0,5)
        const res = await callFlip(HUMAN, 0, 5);
        check('云函数成功', res && res.success === true, JSON.stringify(res).slice(0, 140));
        check('翻中的是机头（scored=true）', res.data.scored === true);
        check('extraTurn 恒为 false（消息结构保持兼容）', res.data.extraTurn === false,
            `extraTurn=${res.data.extraTurn}`);
        check('回合交给对手（不再留给自己）', res.data.nextPlayerId === OTHER,
            `nextPlayerId=${res.data.nextPlayerId}（修复前是 ${HUMAN} = 自己）`);
        check('文档 currentPlayerId 同步为对手', doc().currentPlayerId === OTHER,
            `currentPlayerId=${doc().currentPlayerId}`);
    }

    console.log('\n场景 2：人类翻机身 → 同样换手（与以前一致）');
    {
        setup();
        const res = await callFlip(HUMAN, 1, 1); // 机身
        check('未翻中机头', res.data.scored === false);
        check('回合交给对手', res.data.nextPlayerId === OTHER, res.data.nextPlayerId);
        check('extraTurn=false', res.data.extraTurn === false);
    }

    console.log('\n场景 3：翻中最后一个机头 → 对局结束（回合归属不再重要，但胜负要对）');
    {
        setup();
        const d0 = doc();
        // 先摆成「只剩一个机头没翻」
        const headsLeft = [[0, 5], [3, 0], [3, 5], [6, 6]];
        headsLeft.forEach(([r, c], i) => {
            d0.revealed[r + ',' + c] = { cell: 2, byPlayerId: HUMAN, planeIndex: i + 1 };
        });
        d0.headsFound = 4;
        d0.scores[HUMAN] = 4;
        // 人类翻中最后一个机头 (0,0)
        const res = await callFlip(HUMAN, 0, 0);
        check('翻中最后一个机头', res.data.scored === true);
        check('对局结束', res.data.finished === true, `finished=${res.data.finished}`);
        check('胜者是人类（4+1 vs 0）', res.data.winnerId === HUMAN, res.data.winnerId);
        check('文档标记结束', doc().finished === true);
    }

    console.log('\n场景 4：AI 练习房 —— AI 一手即交回人类（不连翻）');
    {
        setup({ aiSeat: true });
        const res = await callFlip(HUMAN, 1, 1); // 人类翻机身
        check('云函数成功', res && res.success === true);
        check('返回体带 AI 翻格序列', Array.isArray(res.data.aiFlips),
            `aiFlips=${JSON.stringify(res.data.aiFlips)}`);
        check('AI 只翻一格（不再因翻中机头而连翻）',
            !res.data.aiFlips || res.data.aiFlips.length <= 1,
            `AI 翻了 ${res.data.aiFlips && res.data.aiFlips.length} 格`);
        check('回合回到人类', doc().currentPlayerId === HUMAN,
            `currentPlayerId=${doc().currentPlayerId}`);
    }

    console.log('\n场景 5：连续多手，人类与对手交替，不出现「回合停在自己」');
    {
        setup();
        let stuck = null;
        for (let i = 0; i < 6 && !stuck; i++) {
            const d = doc();
            if (d.finished) break;
            const expected = i % 2 === 0 ? HUMAN : OTHER;
            if (d.currentPlayerId !== expected) {
                stuck = `第 ${i + 1} 手：期望轮到 ${expected}，实际 ${d.currentPlayerId}`;
                break;
            }
            const target = firstUnrevealed(d);
            if (!target) break;
            const res = await callFlip(expected, target.r, target.c);
            if (!res || res.success !== true) {
                stuck = `第 ${i + 1} 手被拒: ${JSON.stringify(res).slice(0, 120)}`;
            }
        }
        check('六手内回合严格交替（无「停在自己」）', stuck === null, stuck || '');
    }

    console.log(`\n${fail === 0 ? 'ALL_PLANEHUNT_TURN_PASSED' : 'PLANEHUNT_TURN_FAILURES=' + fail}` +
        `  (${pass} 通过, ${fail} 失败)`);
    process.exit(fail === 0 ? 0 : 1);
})();
