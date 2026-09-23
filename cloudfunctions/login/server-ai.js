/**
 * 服务端 AI 决策（五子棋 / 寻机头）—— 云函数共用。
 *
 * ============================================================================
 * 为什么需要这个文件（背景，2026-09-23）
 * ============================================================================
 * 原实现里 AI 练习房在服务端**只记录人类那一手**，然后把 currentPlayerId
 * 交给 AI 座位，但没有任何「轮到 AI 时替它落子」的逻辑 —— AI 能力当时只
 * 存在于客户端（assets/scripts/games/**\/\*Ai.ts），且仅被 Mock 通道使用。
 * 结果是真机上「我方落子成功、随后永久停在对手回合」。
 *
 * 现在把决策搬到服务端（方案 B）：AI 走法与联机真人走不共用同一条路径，
 * 但**写库与下发都走同一套 gomoku_move / planehunt_flip 的规则**，
 * 因此天然与联机同构、且客户端无法伪造 AI 的落子。
 *
 * ============================================================================
 * ⚠️ 与客户端实现的对齐义务（改一边必须改另一边）
 * ============================================================================
 * 下列算法是 assets/scripts/games/ 下对应文件的**逐行等价移植**：
 *   portFromGomokuRules    ← games/gomoku/GomokuRules.ts
 *   portFromGomokuAi       ← games/gomoku/GomokuAi.ts
 *   portFromPlaneHuntAi    ← games/planehunt/PlaneHuntAi.ts
 * 云函数不能 require 客户端代码（独立部署、且 TS 需编译），只能成对维护。
 * `tools/test-server-ai.js` 会断言关键常量与分支结构一致，改漏了会变红。
 *
 * 难度（AiLevel，与 AppConfig 一致）：1=简单 2=普通 3=困难
 * 决策只依赖**已公开的信息**（棋盘/已翻开格），与客户端 AI 同视角，
 * 不存在「服务端偷看」导致的难度不一致。
 */

// ============================================================================
// 五子棋：规则（只实现 AI 决策所需的最小面）
// ============================================================================

const BLACK = 1;
const WHITE = 2;
const EMPTY = 0;

/** 棋型分值（与 GomokuAi.ts 的 SCORE 完全一致）。 */
const GK_SCORE = {
    FIVE: 1000000,
    FOUR: 100000,
    THREE: 10000,
    SLEEP_THREE: 1000,
    TWO: 100,
    SLEEP_TWO: 10,
    ONE: 1,
};

/** 攻防比：防守权重略高（与 GomokuAi.ts 一致）。 */
const GK_DEFENSE_RATIO = 1.2;

/** 四方向（与两端一致：横 / 竖 / 主对角 / 副对角）。 */
const GK_DIRS = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
];

/**
 * 五子棋 AI 用到的规则视图。
 *
 * 只封装 AI 决策需要的查询（get / inBounds / candidateCells / emptyCells）
 * 与落子应用（applyMove）—— 不复制校验逻辑，落子的**合法性仍由
 * gomoku_move 云函数负责**，本视图只用于「试算与推演」。
 */
class GomokuBoardView {
    /**
     * @param {number[][]} board 二维棋盘（0=空 1=黑 2=白），会被**原地修改**
     * @param {number} size 边长
     * @param {number} winCount 连几子胜
     * @param {string} firstPlayerId 先手（黑）
     * @param {string} secondPlayerId 后手（白）
     */
    constructor(board, size, winCount, firstPlayerId, secondPlayerId) {
        this.board = board;
        this.size = size;
        this.winCount = winCount;
        this._stoneOf = {};
        this._stoneOf[firstPlayerId] = BLACK;
        this._stoneOf[secondPlayerId] = WHITE;
        this._currentPlayerId = firstPlayerId;
        this._moves = countStones(board, size);
    }

    get currentPlayerId() {
        return this._currentPlayerId;
    }

    inBounds(row, col) {
        return row >= 0 && row < this.size && col >= 0 && col < this.size;
    }

    get(row, col) {
        if (!this.inBounds(row, col)) {
            return EMPTY;
        }
        return this.board[row][col];
    }

    stoneOf(playerId) {
        const s = this._stoneOf[playerId];
        return s === undefined ? EMPTY : s;
    }

    opponentOf(playerId) {
        for (const id in this._stoneOf) {
            if (id !== playerId) {
                return id;
            }
        }
        return '';
    }

    /** 全部空位（与 GomokuRules.emptyCells 同序：行优先）。 */
    emptyCells() {
        const out = [];
        for (let r = 0; r < this.size; r++) {
            for (let c = 0; c < this.size; c++) {
                if (this.board[r][c] === EMPTY) {
                    out.push({ row: r, col: c });
                }
            }
        }
        return out;
    }

    /**
     * 候选格（与 GomokuRules.candidateCells 同序同剪枝）。
     *
     * 注意顺序必须一致：AI 取「首个最高分」，候选顺序变了走法就会变。
     */
    candidateCells(radius) {
        const rad = typeof radius === 'number' ? radius : 2;
        if (this._moves === 0) {
            const mid = Math.floor(this.size / 2);
            return [{ row: mid, col: mid }];
        }
        const seen = {};
        const out = [];
        for (let r = 0; r < this.size; r++) {
            for (let c = 0; c < this.size; c++) {
                if (this.board[r][c] === EMPTY) {
                    continue;
                }
                for (let dr = -rad; dr <= rad; dr++) {
                    for (let dc = -rad; dc <= rad; dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (!this.inBounds(nr, nc)) {
                            continue;
                        }
                        const k = nr * this.size + nc;
                        if (this.board[nr][nc] !== EMPTY || seen[k]) {
                            continue;
                        }
                        seen[k] = true;
                        out.push({ row: nr, col: nc });
                    }
                }
            }
        }
        return out;
    }

    /** 应用落子（只做棋盘写入与回合切换；胜负由调用方的 checkWin 负责）。 */
    applyMove(row, col, playerId) {
        const stone = this.stoneOf(playerId);
        if (stone === EMPTY || this.get(row, col) !== EMPTY) {
            return false;
        }
        this.board[row][col] = stone;
        this._moves++;
        this._currentPlayerId = this.opponentOf(playerId);
        return true;
    }
}

/** 统计棋盘上的棋子数（用于 _moves 初值）。 */
function countStones(board, size) {
    let n = 0;
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (board[r][c] !== EMPTY) {
                n++;
            }
        }
    }
    return n;
}

/**
 * 五子棋 AI 决策（GomokuAi.decide 的等价移植）。
 *
 * 三级优先级，顺序不可调换（客户端注释里记录过：把「己方成五」并进综合
 * 评分会被防守权重盖过，导致 AI 为了堵对方而放弃自己的胜利）：
 *   ① 己方一步成五 → 直接下
 *   ② 对方一步成五 → 必须封堵
 *   ③ 综合评分 attack + defense × 1.2，取最高
 *
 * @returns {{row:number,col:number,score:number}|null}
 */
function gomokuDecide(view, aiPlayerId, firstPlayerId, level) {
    const myStone = aiPlayerId === firstPlayerId ? BLACK : WHITE;
    const oppStone = myStone === BLACK ? WHITE : BLACK;
    const radius = level === 1 ? 1 : 2; // AiLevel.EASY=1

    const candidates = view.candidateCells(radius);
    if (candidates.length === 0) {
        const empties = view.emptyCells();
        return empties.length > 0 ? { row: empties[0].row, col: empties[0].col, score: 0 } : null;
    }

    // ① 己方直接成五
    for (let i = 0; i < candidates.length; i++) {
        const cell = candidates[i];
        const attack = scorePoint(view, cell.row, cell.col, myStone);
        if (attack >= GK_SCORE.FIVE) {
            return { row: cell.row, col: cell.col, score: attack };
        }
    }

    // ② 对方成五 → 封堵
    let block = null;
    for (let i = 0; i < candidates.length; i++) {
        const cell = candidates[i];
        const defense = scorePoint(view, cell.row, cell.col, oppStone);
        if (defense >= GK_SCORE.FIVE) {
            if (!block || defense > block.score) {
                block = { row: cell.row, col: cell.col, score: defense };
            }
        }
    }
    if (block) {
        return block;
    }

    // ③ 综合评分
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
        const cell = candidates[i];
        const attack = scorePoint(view, cell.row, cell.col, myStone);
        const defense = scorePoint(view, cell.row, cell.col, oppStone);
        const total = attack + defense * GK_DEFENSE_RATIO;
        if (!best || total > best.score) {
            best = { row: cell.row, col: cell.col, score: total };
        }
    }
    return best;
}

/** 假设在 (row,col) 落 stone，取四方向中的最高分。 */
function scorePoint(view, row, col, stone) {
    let best = 0;
    for (let d = 0; d < GK_DIRS.length; d++) {
        const s = scoreDirection(view, row, col, GK_DIRS[d][0], GK_DIRS[d][1], stone);
        if (s > best) {
            best = s;
        }
    }
    return best;
}

/** 单方向棋型评分（与 GomokuAi._scoreDirection 等价）。 */
function scoreDirection(view, row, col, dr, dc, stone) {
    let count = 1;
    let openEnds = 0;

    // 正方向
    for (let step = 1; step < view.winCount; step++) {
        const r = row + dr * step;
        const c = col + dc * step;
        if (!view.inBounds(r, c)) {
            break;
        }
        const v = view.get(r, c);
        if (v === stone) {
            count++;
        } else if (v === EMPTY) {
            openEnds++;
            break;
        } else {
            break;
        }
    }

    // 反方向
    for (let step = 1; step < view.winCount; step++) {
        const r = row - dr * step;
        const c = col - dc * step;
        if (!view.inBounds(r, c)) {
            break;
        }
        const v = view.get(r, c);
        if (v === stone) {
            count++;
        } else if (v === EMPTY) {
            openEnds++;
            break;
        } else {
            break;
        }
    }

    if (openEnds === 0 && count < view.winCount) {
        return 0;
    }
    return mapScore(count, openEnds, view.winCount);
}

/** 棋型 → 分值（与 GomokuAi._mapScore 等价）。 */
function mapScore(count, openEnds, winCount) {
    if (count >= winCount) {
        return GK_SCORE.FIVE;
    }
    if (count === 4) {
        // 单/双活端同为 FOUR（冲四也要拦，与客户端一致）
        return openEnds === 2 ? GK_SCORE.FOUR : openEnds === 1 ? GK_SCORE.FOUR : 0;
    }
    if (count === 3) {
        return openEnds === 2 ? GK_SCORE.THREE : openEnds === 1 ? GK_SCORE.SLEEP_THREE : 0;
    }
    if (count === 2) {
        return openEnds === 2 ? GK_SCORE.TWO : openEnds === 1 ? GK_SCORE.SLEEP_TWO : 0;
    }
    return GK_SCORE.ONE;
}

// ============================================================================
// 寻机头 AI
// ============================================================================

/** 机身格标记（与客户端 PlaneHuntLayout.CELL_BODY 一致：1=机身 2=机头）。 */
const PH_CELL_BODY = 1;

/**
 * 寻机头 AI 决策（PlaneHuntAi.decide 的等价移植）。
 *
 * 策略：优先探索「已揭示机身」的四邻域找关联机头；无信息则随机选未翻开格。
 *
 * ⚠️ 随机源由调用方注入 `rng`（服务端用 seed 派生的确定性随机流），
 *    而不是 Math.random —— 这样同一 seed+同一棋局下 AI 走法可复现，
 *    便于日志排查与回归测试。客户端 Mock 用 Math.random（仅本地体验，无需复现）。
 *
 * @param {object} state { size, revealed（二维 bool 或 0/1）, cells（二维，1=机身） }
 * @param {{int:function(number,number):number}} rng 确定性随机源
 * @returns {{row:number,col:number,reason:string}|null}
 */
function planeHuntDecide(state, rng) {
    const size = state.size;
    const unopened = [];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (!isRevealed(state, r, c)) {
                unopened.push({ row: r, col: c });
            }
        }
    }
    if (unopened.length === 0) {
        return null;
    }

    const neighbors = findBodyNeighbors(state);
    if (neighbors.length > 0) {
        const pick = neighbors[rng.int(0, neighbors.length - 1)];
        return { row: pick.row, col: pick.col, reason: 'neighbor' };
    }

    const pick = unopened[rng.int(0, unopened.length - 1)];
    return { row: pick.row, col: pick.col, reason: 'random' };
}

/** 是否已翻开（兼容 bool 与 0/1 两种存储形态）。 */
function isRevealed(state, r, c) {
    const row = state.revealed[r];
    if (!row) {
        return false;
    }
    return row[c] === true || row[c] === 1;
}

/**
 * 已揭示机身的未翻开四邻域（与 PlaneHuntAi._findBodyNeighbors 同序）。
 *
 * 顺序必须与客户端一致：AI 在候选里等概率取一个，候选集合/顺序变了走法就变。
 * 遍历顺序 = 按行优先扫「已揭示格」，每格再按 右/下/左/上 四方向。
 */
function findBodyNeighbors(state) {
    const out = [];
    const seen = {};
    const dirs = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
    ];
    const size = state.size;

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (!isRevealed(state, r, c)) {
                continue;
            }
            if (state.cells[r][c] !== PH_CELL_BODY) {
                continue;
            }
            for (let d = 0; d < dirs.length; d++) {
                const nr = r + dirs[d][0];
                const nc = c + dirs[d][1];
                if (nr < 0 || nr >= size || nc < 0 || nc >= size) {
                    continue;
                }
                if (isRevealed(state, nr, nc)) {
                    continue;
                }
                const k = nr * size + nc;
                if (seen[k]) {
                    continue;
                }
                seen[k] = true;
                out.push({ row: nr, col: nc });
            }
        }
    }
    return out;
}

module.exports = {
    BLACK,
    WHITE,
    EMPTY,
    GK_SCORE,
    GK_DEFENSE_RATIO,
    PH_CELL_BODY,
    GomokuBoardView,
    gomokuDecide,
    scorePoint,
    scoreDirection,
    mapScore,
    planeHuntDecide,
    findBodyNeighbors,
    isRevealed,
};
