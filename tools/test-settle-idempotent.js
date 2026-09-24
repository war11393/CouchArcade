/**
 * settleGame 幂等性验证（开发辅助脚本，不参与游戏运行）。
 *
 * 手法与 tools/test-gomoku-ai-e2e.js 相同：内存库桩顶替 wx-server-sdk，
 * 直接 require 真实云函数 —— 跑的就是线上那套代码。
 *
 * 守护的行为（2026-09-24 实测确证过的数据错误）：
 *   客户端有两条路径都调 settleGame（投降时 WxNetSync 直接调一次、展示结算时
 *   saveMatchRecord 又调一次），而原实现每次调用都无条件写战绩 + 累加胜负，
 *   于是「投降一次 = 两条战绩 + 胜场加两次」。
 *
 * 运行：node tools/test-settle-idempotent.js
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
const settleGame = require(path.join(ROOT, 'cloudfunctions', 'settleGame', 'index.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const HUMAN = 'oHuman';
const OTHER = 'oOther';
const ROOM = '654321';

/** 造一个「已打完、待结算」的房间。 */
function setup({ status = 'playing', finishedAt } = {}) {
    store.collections = {
        rooms: [{
            _id: 'r1', roomId: ROOM, gameId: 'gomoku',
            status, ownerId: HUMAN, isPractice: false,
            finishedAt,
            seats: [
                { seatIndex: 0, playerId: HUMAN, nickname: '甲', ready: true, isAI: false, score: 0 },
                { seatIndex: 1, playerId: OTHER, nickname: '乙', ready: true, isAI: false, score: 0 },
            ],
            startedAt: Date.now() - 60000,
        }],
        games_gomoku: [{
            _id: 'g1', roomId: ROOM, size: 15, winCount: 5,
            board: [], history: [], moveCount: 10,
            currentPlayerId: HUMAN, finished: true, winnerId: HUMAN, draw: false,
        }],
        match_records: [],
        users: [
            { _id: 'u1', openid: HUMAN, nickname: '甲', winCount: 0, loseCount: 0, drawCount: 0 },
            { _id: 'u2', openid: OTHER, nickname: '乙', winCount: 0, loseCount: 0, drawCount: 0 },
        ],
    };
}

global.__OID = HUMAN;

(async () => {
    console.log('=== settleGame 幂等性回归测试 ===\n');

    console.log('场景 1：正常首次结算（应当写入，且只写一次）');
    {
        setup();
        const r = await settleGame.main({ roomId: ROOM, durationMs: 1000 }, {});
        check('首次调用成功', r && r.success === true, JSON.stringify(r).slice(0, 120));
        check('写入 2 条战绩（甲乙各一）', r.data.records.length === 2, `records=${r.data.records.length}`);
        check('match_records 共 2 条', store.collections.match_records.length === 2,
            `实际 ${store.collections.match_records.length}`);
        check('甲胜场 = 1', store.collections.users[0].winCount === 1,
            `实际 ${store.collections.users[0].winCount}`);
        check('乙负场 = 1', store.collections.users[1].loseCount === 1,
            `实际 ${store.collections.users[1].loseCount}`);
    }

    console.log('\n场景 2：重复结算（投降会触发两次 —— 必须幂等）');
    {
        setup();
        const r1 = await settleGame.main({ roomId: ROOM, durationMs: 1000 }, {});
        const r2 = await settleGame.main({ roomId: ROOM, durationMs: 1000 }, {});
        check('第 1 次写入 2 条', r1.data.records.length === 2, `records=${r1.data.records.length}`);
        check('第 2 次不写战绩（records 为空）', r2.data.records.length === 0,
            `records=${r2.data.records.length}（修复前这里会是 2）`);
        check('第 2 次标记为幂等跳过',
            r2.data.judgmentSource === 'idempotent_skip', r2.data.judgmentSource);
        check('match_records 仍是 2 条（修复前是 4）',
            store.collections.match_records.length === 2,
            `实际 ${store.collections.match_records.length} —— 战绩重复累加就是这个 bug`);
        check('甲胜场仍是 1（修复前是 2）',
            store.collections.users[0].winCount === 1,
            `实际 ${store.collections.users[0].winCount}`);
        check('幂等返回带出既有胜者（客户端可正常展示）',
            r2.data.winnerId === HUMAN, r2.data.winnerId);
    }

    console.log('\n场景 3：连点 5 次（极端）');
    {
        setup();
        for (let i = 0; i < 5; i++) {
            await settleGame.main({ roomId: ROOM, durationMs: 1000 }, {});
        }
        check('连胜多次后战绩仍只有 2 条',
            store.collections.match_records.length === 2,
            `实际 ${store.collections.match_records.length}`);
        check('胜场仍为 1', store.collections.users[0].winCount === 1,
            `实际 ${store.collections.users[0].winCount}`);
    }

    console.log('\n场景 4：投降路径（客户端上报结果 + 无对局文档）');
    {
        setup();
        // 模拟投降：房间无 finished 的对局文档（服务端无法推导）
        store.collections.games_gomoku[0].finished = false;
        const r = await settleGame.main(
            { roomId: ROOM, result: { winnerId: OTHER, draw: false, reason: 'surrender' } }, {});
        check('投降结算成功', r.success === true);
        check('以客户端上报为准（胜者=对手）', r.data.winnerId === OTHER, r.data.winnerId);
        check('写入 2 条战绩', store.collections.match_records.length === 2,
            `实际 ${store.collections.match_records.length}`);
        check('判定来源标为 client_reported', r.data.judgmentSource === 'client_reported');

        // 投降后再来一次（结算展示时的那次调用）→ 必须幂等
        const r2 = await settleGame.main(
            { roomId: ROOM, result: { winnerId: OTHER, draw: false, reason: 'surrender' } }, {});
        check('投降后重复调用不再写战绩',
            store.collections.match_records.length === 2,
            `实际 ${store.collections.match_records.length} —— 修复前投降会写 4 条`);
        check('标记幂等跳过', r2.data.judgmentSource === 'idempotent_skip');
    }

    console.log(`\n${fail === 0 ? 'ALL_SETTLE_IDEMPOTENT_PASSED' : 'SETTLE_IDEMPOTENT_FAILURES=' + fail}` +
        `  (${pass} 通过, ${fail} 失败)`);
    process.exit(fail === 0 ? 0 : 1);
})();
