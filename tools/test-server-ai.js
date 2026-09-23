/**
 * 服务端 AI 与客户端 AI 的**等价性差分测试**（开发辅助脚本，不参与游戏运行）。
 *
 * 为什么必须有这个测试：
 *   `cloudfunctions/common/server-ai.js` 是客户端
 *   `assets/scripts/games/gomoku/GomokuAi.ts` 与
 *   `assets/scripts/games/planehunt/PlaneHuntAi.ts` 的**手工移植**。
 *   云函数不能 require 客户端 TS 代码，所以两份实现只能成对维护 ——
 *   一旦哪边改了评分权重/候选顺序/优先级，真机 AI 走法就会与 Mock 不一致，
 *   而这种偏差**不会报错**，只会表现为「AI 变笨了/变强了」，极难发现。
 *
 * 做法：把客户端算法按同一随机棋盘跑一遍，与服务端移植版逐步对比落子点。
 *   客户端侧用正则把 TS 里的关键常量抽出来核对（防止权重漂移），
 *   再用一份 **JS 复刻的客户端算法** 与服务端版对多组随机棋局做逐位比对。
 *
 * 运行：node tools/test-server-ai.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const serverAi = require(path.join(ROOT, 'cloudfunctions', 'common', 'server-ai.js'));

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

console.log('=== 服务端 AI 与客户端 AI 等价性测试 ===\n');

// =====================================================================
// 第一部分：常量对齐（防止权重/比例漂移）
// =====================================================================
const gomokuAiSrc = read('assets/scripts/games/gomoku/GomokuAi.ts');

console.log('场景 1：五子棋评分权重与客户端一致');
{
    const want = {
        FIVE: 1000000, FOUR: 100000, THREE: 10000,
        SLEEP_THREE: 1000, TWO: 100, SLEEP_TWO: 10, ONE: 1,
    };
    for (const key of Object.keys(want)) {
        check(`SCORE.${key} = ${want[key]}`,
            serverAi.GK_SCORE[key] === want[key],
            `服务端=${serverAi.GK_SCORE[key]} 期望=${want[key]}`);
    }
    check('攻防比 DEFENSE_RATIO = 1.2',
        serverAi.GK_DEFENSE_RATIO === 1.2, `服务端=${serverAi.GK_DEFENSE_RATIO}`);
    // 客户端源码里也必须还是 1.2（若客户端改了而服务端没改，这里会红）
    check('客户端源码仍是 1.2', /DEFENSE_RATIO\s*=\s*1\.2/.test(gomokuAiSrc),
        '客户端改了攻防比，服务端需同步');
}

console.log('\n场景 2：候选半径按难度分档（EASY=1，其余=2）');
{
    check('服务端 EASY(level=1) 用 radius=1', /level === 1 \? 1 : 2/.test(
        read('cloudfunctions/common/server-ai.js')));
    check('客户端 EASY 用 radius=1',
        /AiLevel\.EASY\s*\?\s*1\s*:\s*2/.test(gomokuAiSrc),
        '客户端候选半径分档与注释不一致');
}

// =====================================================================
// 第二部分：算法差分（随机棋局逐位比对）
// =====================================================================

/**
 * 客户端 GomokuAi 的 JS 复刻（严格照 GomokuAi.ts 写）。
 * 注意：这是测试用的**独立复刻**，故意不复用服务端实现 ——
 * 否则「两边都是同一份代码」，差分测试就失去意义了。
 */
function clientGomokuDecide(board, size, winCount, aiPlayerId, firstPlayerId, level) {
    const BLACK = 1, WHITE = 2, EMPTY = 0;
    const SCORE = {
        FIVE: 1000000, FOUR: 100000, THREE: 10000,
        SLEEP_THREE: 1000, TWO: 100, SLEEP_TWO: 10, ONE: 1,
    };
    const DEFENSE_RATIO = 1.2;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];

    const myStone = aiPlayerId === firstPlayerId ? BLACK : WHITE;
    const oppStone = myStone === BLACK ? WHITE : BLACK;

    let moves = 0;
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (board[r][c] !== EMPTY) moves++;
        }
    }

    const inBounds = (r, c) => r >= 0 && r < size && c >= 0 && c < size;
    const get = (r, c) => (inBounds(r, c) ? board[r][c] : EMPTY);

    // candidateCells
    function candidateCells(radius) {
        if (moves === 0) {
            const mid = Math.floor(size / 2);
            return [{ row: mid, col: mid }];
        }
        const seen = new Set();
        const out = [];
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (board[r][c] === EMPTY) continue;
                for (let dr = -radius; dr <= radius; dr++) {
                    for (let dc = -radius; dc <= radius; dc++) {
                        const nr = r + dr, nc = c + dc;
                        if (!inBounds(nr, nc)) continue;
                        const k = nr * size + nc;
                        if (board[nr][nc] !== EMPTY || seen.has(k)) continue;
                        seen.add(k);
                        out.push({ row: nr, col: nc });
                    }
                }
            }
        }
        return out;
    }

    function emptyCells() {
        const out = [];
        for (let r = 0; r < size; r++)
            for (let c = 0; c < size; c++)
                if (board[r][c] === EMPTY) out.push({ row: r, col: c });
        return out;
    }

    function mapScore(count, openEnds) {
        if (count >= winCount) return SCORE.FIVE;
        if (count === 4) return openEnds === 2 ? SCORE.FOUR : openEnds === 1 ? SCORE.FOUR : 0;
        if (count === 3) return openEnds === 2 ? SCORE.THREE : openEnds === 1 ? SCORE.SLEEP_THREE : 0;
        if (count === 2) return openEnds === 2 ? SCORE.TWO : openEnds === 1 ? SCORE.SLEEP_TWO : 0;
        return SCORE.ONE;
    }

    function scoreDirection(row, col, dr, dc, stone) {
        let count = 1, openEnds = 0;
        for (let step = 1; step < winCount; step++) {
            const r = row + dr * step, c = col + dc * step;
            if (!inBounds(r, c)) break;
            const v = get(r, c);
            if (v === stone) count++;
            else if (v === EMPTY) { openEnds++; break; }
            else break;
        }
        for (let step = 1; step < winCount; step++) {
            const r = row - dr * step, c = col - dc * step;
            if (!inBounds(r, c)) break;
            const v = get(r, c);
            if (v === stone) count++;
            else if (v === EMPTY) { openEnds++; break; }
            else break;
        }
        if (openEnds === 0 && count < winCount) return 0;
        return mapScore(count, openEnds);
    }

    function scorePoint(row, col, stone) {
        let best = 0;
        for (const [dr, dc] of dirs) {
            const s = scoreDirection(row, col, dr, dc, stone);
            if (s > best) best = s;
        }
        return best;
    }

    const candidates = candidateCells(level === 1 ? 1 : 2);
    if (candidates.length === 0) {
        const empties = emptyCells();
        return empties.length > 0 ? { row: empties[0].row, col: empties[0].col, score: 0 } : null;
    }

    for (const cell of candidates) {
        const attack = scorePoint(cell.row, cell.col, myStone);
        if (attack >= SCORE.FIVE) return { row: cell.row, col: cell.col, score: attack };
    }

    let block = null;
    for (const cell of candidates) {
        const defense = scorePoint(cell.row, cell.col, oppStone);
        if (defense >= SCORE.FIVE) {
            if (!block || defense > block.score) block = { row: cell.row, col: cell.col, score: defense };
        }
    }
    if (block) return block;

    let best = null;
    for (const cell of candidates) {
        const attack = scorePoint(cell.row, cell.col, myStone);
        const defense = scorePoint(cell.row, cell.col, oppStone);
        const total = attack + defense * DEFENSE_RATIO;
        if (!best || total > best.score) best = { row: cell.row, col: cell.col, score: total };
    }
    return best;
}

/** 确定性伪随机（LCG），保证测试可复现。 */
function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

console.log('\n场景 3：随机棋局差分（服务端移植 == 客户端算法）');
{
    const SIZE = 15;
    const WIN = 5;
    const A_ID = 'ai-1';
    const H_ID = 'human-1';

    let mismatches = 0;
    let compared = 0;
    const CASES = [
        { level: 2, stones: [0, 1, 2, 5, 20] },
        { level: 1, stones: [0, 1, 2, 5, 20] },
        { level: 3, stones: [3, 8, 15] },
    ];

    for (const cs of CASES) {
        for (const n of cs.stones) {
            for (let trial = 0; trial < 4; trial++) {
                const rng = makeRng(cs.level * 1000 + n * 17 + trial);
                const board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
                let placed = 0;
                let turn = 0;
                while (placed < n) {
                    const r = Math.floor(rng() * SIZE);
                    const c = Math.floor(rng() * SIZE);
                    if (board[r][c] !== 0) continue;
                    board[r][c] = turn % 2 === 0 ? 1 : 2;
                    placed++;
                    turn++;
                }

                const client = clientGomokuDecide(board, SIZE, WIN, A_ID, H_ID, cs.level);

                // 服务端：深拷贝棋盘（服务端实现会原地写 board 做试算？不会，
                // 但 applyMove 会，故这里保持独立副本）
                const board2 = board.map((row) => row.slice());
                const view = new serverAi.GomokuBoardView(board2, SIZE, WIN, H_ID, A_ID);
                const server = serverAi.gomokuDecide(view, A_ID, H_ID, cs.level);

                compared++;
                const same = !!client === !!server
                    && (!client || (client.row === server.row && client.col === server.col));
                if (!same) {
                    mismatches++;
                    if (mismatches <= 3) {
                        console.error(`      差异 level=${cs.level} n=${n} trial=${trial}: ` +
                            `客户端=(${client && client.row},${client && client.col}) ` +
                            `服务端=(${server && server.row},${server && server.col})`);
                    }
                }
            }
        }
    }
    check(`全部 ${compared} 组棋局落子点完全一致`, mismatches === 0, `不一致 ${mismatches} 组`);
}

console.log('\n场景 4：关键战术行为（成五优先 / 封堵五连）');
{
    const SIZE = 15, WIN = 5;
    // 黑(AI) 有 4 连 (7,3)-(7,6)，应下 (7,2) 或 (7,7) 成五
    const b1 = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    for (let c = 3; c <= 6; c++) b1[7][c] = 1;
    {
        const view = new serverAi.GomokuBoardView(b1.map((r) => r.slice()), SIZE, WIN, 'ai-1', 'h-1');
        const d = serverAi.gomokuDecide(view, 'ai-1', 'ai-1', 2);
        check('己方四连 → 补成五（不因防守分反超而放弃）',
            d && d.row === 7 && (d.col === 2 || d.col === 7),
            `实际=(${d && d.row},${d && d.col})`);
    }

    // 白(对手) 有 4 连，AI 是黑，必须封堵
    const b2 = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    for (let c = 3; c <= 6; c++) b2[7][c] = 2;
    {
        const view = new serverAi.GomokuBoardView(b2.map((r) => r.slice()), SIZE, WIN, 'ai-1', 'h-1');
        const d = serverAi.gomokuDecide(view, 'ai-1', 'ai-1', 2);
        check('对手四连 → 必须封堵',
            d && d.row === 7 && (d.col === 2 || d.col === 7),
            `实际=(${d && d.row},${d && d.col})`);
    }

    // 空盘首手 → 天元
    {
        const b3 = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
        const view = new serverAi.GomokuBoardView(b3, SIZE, WIN, 'ai-1', 'h-1');
        const d = serverAi.gomokuDecide(view, 'ai-1', 'ai-1', 2);
        check('空盘首手落天元(7,7)', d && d.row === 7 && d.col === 7,
            `实际=(${d && d.row},${d && d.col})`);
    }
}

console.log('\n场景 5：寻机头 AI 邻域优先 + 确定性随机');
{
    const SIZE = 12;
    // 造一个 3x3：机身在 (5,5)，未翻开其余
    const cells = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    const revealed = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));
    cells[5][5] = serverAi.PH_CELL_BODY;
    revealed[5][5] = true;

    const state = { size: SIZE, cells, revealed };
    const neighbors = serverAi.findBodyNeighbors(state);
    check('机身四邻域被识别（4 个）', neighbors.length === 4,
        `实际 ${neighbors.length} 个`);

    const rng = { int: (min, max) => min }; // 取候选第一个，保证确定性
    const d = serverAi.planeHuntDecide(state, rng);
    check('优先探索机身邻域', d && d.reason === 'neighbor', `reason=${d && d.reason}`);
    check('落点在四邻域内', d && Math.abs(d.row - 5) + Math.abs(d.col - 5) === 1,
        `实际=(${d && d.row},${d && d.col})`);

    // 全盘翻开 → null
    const allRev = { size: SIZE, cells, revealed: Array.from({ length: SIZE }, () => new Array(SIZE).fill(true)) };
    check('无可用格返回 null', serverAi.planeHuntDecide(allRev, rng) === null);

    // 无机身信息 → random
    const noBody = {
        size: SIZE,
        cells: Array.from({ length: SIZE }, () => new Array(SIZE).fill(0)),
        revealed: Array.from({ length: SIZE }, () => new Array(SIZE).fill(false)),
    };
    const d2 = serverAi.planeHuntDecide(noBody, rng);
    check('无信息时随机选格', d2 && d2.reason === 'random', `reason=${d2 && d2.reason}`);
}

console.log('\n场景 6：确定性随机源（同 seed 走法可复现）');
{
    // 服务端用 seed 派生 rng，而非 Math.random —— 便于日志排查与回归
    const src = read('cloudfunctions/common/server-ai.js');
    check('AI 模块不直接使用 Math.random', !/Math\.random\(/.test(src),
        '服务端 AI 用了 Math.random，同一 seed 下走法不可复现');
    check('随机源由调用方注入（rng 参数）', /planeHuntDecide\(state, rng\)/.test(src));
}

console.log(`\n${fail === 0 ? 'ALL_SERVER_AI_TESTS_PASSED' : 'SERVER_AI_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
