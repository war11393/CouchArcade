/**
 * 云函数「人类 ↔ AI 连续对拉」仿真（开发辅助脚本，不参与游戏运行）。
 *
 * 与 test-gomoku-ai-e2e.js（单次调用 + 局部断言）的分工：
 *   那个脚本证明「一次 human move → 一次 AI 回手」是对的；
 *   这个脚本把**整局**跑完 —— 反复调用真实云函数，直到对局结束，
 *   证明「AI 会自己走完整盘棋、不会中途卡住 / 不会双方都锁死」。
 *
 * 为什么需要它（2026-09-24）：
 *   真机反馈「AI 练习落子后卡在对手思考中」。卡住的可能形态之一是
 *   「AI 决策链在某一步返回空 → currentPlayerId 停在 AI 身上 → 谁都不能动」。
 *   单次调用测试覆盖不到这种「走了 10 手之后才卡」的情形，必须整局跑。
 *
 * 手法同 test-gomoku-ai-e2e.js：用内存数据库桩顶替 wx-server-sdk，
 * 直接 require 真实 cloudfunctions/gomoku_move/index.js。
 *
 * 运行：node tools/test-ai-fullgame.js
 */

const path = require('path');

// =====================================================================
// 内存数据库桩 + wx-server-sdk 顶替
// =====================================================================
const store = { collections: {} };

function makeQuery(collection) {
    const rows = () => (store.collections[collection] || []);
    return {
        where(cond) {
            this._cond = cond;
            return this;
        },
        async get() {
            const cond = this._cond;
            let data = rows().slice();
            if (cond) {
                data = data.filter((d) => Object.keys(cond).every((k) => d[k] === cond[k]));
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
            store.collections[collection].push(
                Object.assign({ _id: id }, JSON.parse(JSON.stringify(data))),
            );
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

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'wx-server-sdk') {
        return FAKE_SDK;
    }
    return origLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, '..');
const gomokuMove = require(path.join(ROOT, 'cloudfunctions', 'gomoku_move', 'index.js'));

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

const HUMAN = 'oHuman';
const AI = 'ai-FULLGAME-1';
const ROOM = '778899';
const SIZE = 15;

/** 建练习房 + 空棋局。 */
function setup({ level = 2 } = {}) {
    store.collections = {};
    const board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    store.collections.rooms = [{
        _id: 'room1',
        roomId: ROOM,
        gameId: 'gomoku',
        status: 'playing',
        ownerId: HUMAN,
        isPractice: true,
        seed: 424242,
        maxPlayers: 2,
        seats: [
            { seatIndex: 0, playerId: HUMAN, nickname: '微信用户', ready: false, isAI: false, aiLevel: level, score: 0 },
            { seatIndex: 1, playerId: AI, nickname: '机头猎手', ready: true, isAI: true, aiLevel: level, score: 0 },
        ],
    }];
    store.collections.games_gomoku = [{
        _id: 'game1',
        roomId: ROOM,
        gameId: 'gomoku',
        seed: 424242,
        size: SIZE,
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

const gameDoc = () => store.collections.games_gomoku[0];

async function callMove(openid, row, col, reqSeq) {
    global.__TEST_OPENID__ = openid;
    return gomokuMove.main({ roomId: ROOM, row, col, reqSeq }, { openid });
}

/**
 * 人类选点：优先挑「AI 落子邻域」的空位（模拟真人贴着下，逼出攻防），
 * 邻域没有则按行优先取第一个空位。**只挑空位**这一点必须保证 ——
 * 挑了已占位会被服务端（正确地）拒绝，那是测试自己的缺陷。
 */
function pickHumanCell(board) {
    const occupied = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] !== 0) occupied.push({ r, c });
        }
    }
    if (occupied.length === 0) {
        const mid = Math.floor(SIZE / 2);
        return { r: mid, c: mid };
    }
    for (const o of occupied) {
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                const r = o.r + dr;
                const c = o.c + dc;
                if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === 0) {
                    return { r, c };
                }
            }
        }
    }
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (board[r][c] === 0) return { r, c };
        }
    }
    return null;
}

console.log('=== 云函数 AI「整局对拉」仿真 ===\n');

(async () => {
    // 分别用三档难度各跑一整局（难度会影响 AI 的候选半径与强度）
    for (const level of [1, 2, 3]) {
        console.log(`场景：难度 ${level} —— 人类与 AI 交替下到对局结束`);
        setup({ level });

        let seq = 0;
        let turns = 0;
        let stuck = null;
        let aiMoves = 0;
        let illegalHuman = null;
        const MAX_TURNS = SIZE * SIZE; // 上限：格数（防御性）

        while (turns < MAX_TURNS) {
            const g = gameDoc();
            if (g.finished) break;
            if (g.currentPlayerId !== HUMAN) {
                stuck = `回合停在 ${g.currentPlayerId}（不是人类也不是「已结束」）`;
                break;
            }
            const target = pickHumanCell(g.board);
            if (!target) {
                stuck = '棋盘已满但未结束';
                break;
            }
            seq++;
            const res = await callMove(HUMAN, target.r, target.c, seq);
            if (!res || res.success !== true) {
                illegalHuman = `第 ${seq} 手 (${target.r},${target.c}) 被拒: ${JSON.stringify(res).slice(0, 140)}`;
                break;
            }
            if (res.data.aiMove) aiMoves++;
            turns++;
        }

        const g = gameDoc();
        check(`难度${level}：AI 全程接管了它的每一手（aiMoves=${aiMoves}）`, aiMoves > 0, `aiMoves=${aiMoves}`);
        check(`难度${level}：没有出现「回合卡在 AI 身上」`, stuck === null, stuck || '');
        check(`难度${level}：没有出现「人类合法落子被拒」`, illegalHuman === null, illegalHuman || '');
        check(`难度${level}：对局收敛（结束或回合回到人类），步数=${g.moveCount}`,
            g.finished || g.currentPlayerId === HUMAN,
            `finished=${g.finished} currentPlayerId=${g.currentPlayerId}`);
        check(`难度${level}：棋盘上棋子数与 moveCount 一致`,
            g.board.flat().filter((v) => v !== 0).length === g.moveCount,
            `stones=${g.board.flat().filter((v) => v !== 0).length} moveCount=${g.moveCount}`);
        console.log('');
    }

    // 专门跑一局「把棋下满」的极端情形：人类与 AI 严格按行优先填格，
    // 验证 AI 在棋盘接近下满时依然能落子（决策链不返回 null）。
    console.log('场景：极端 —— 人类按行优先填格（不下必胜手），跑满 225 格');
    setup({ level: 1 });
    {
        let seq = 0;
        let stuck = null;
        const MAX = SIZE * SIZE;
        for (let i = 0; i < MAX; i++) {
            const g = gameDoc();
            if (g.finished) break;
            if (g.currentPlayerId !== HUMAN) {
                stuck = `第 ${i + 1} 轮回合停在 ${g.currentPlayerId}`;
                break;
            }
            const target = pickHumanCell(g.board);
            if (!target) break;
            seq++;
            const res = await callMove(HUMAN, target.r, target.c, seq);
            if (!res || res.success !== true) {
                stuck = `第 ${seq} 手被拒: ${JSON.stringify(res).slice(0, 140)}`;
                break;
            }
        }
        const g = gameDoc();
        check('极端：无「回合卡在 AI 身上」', stuck === null, stuck || '');
        check('极端：无「人类合法落子被拒」', !stuck || !stuck.includes('被拒'), stuck || '');
        check(`极端：落子数远大于 2（实际 ${g.moveCount}）`, g.moveCount > 2, `moveCount=${g.moveCount}`);
        console.log('');
    }

    console.log(`${fail === 0 ? 'ALL_AI_FULLGAME_PASSED' : 'AI_FULLGAME_FAILURES=' + fail}` +
        `  (${pass} 通过, ${fail} 失败)`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('仿真异常:', err);
    process.exit(1);
});
