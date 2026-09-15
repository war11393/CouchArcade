/**
 * 五子棋 AI：评分启发式。
 *
 * 策略（规格要求）：
 * - 遍历空位，分别计算「己方落子得分」与「阻挡对方得分」，取综合最高分落子；
 * - 权重：活五 > 冲四/活四 > 活三 > 眠三 > 活二；
 * - 攻防比约 1:1.2，略偏防守；
 * - 定位「新手能赢、有挑战性」。
 *
 * 纯逻辑实现，无 Cocos 依赖，可单元测试。
 */

import { AiLevel } from '../../config/AppConfig';
import { BLACK, GomokuRules, Stone, WHITE } from './GomokuRules';

/** AI 决策结果。 */
export interface GomokuAiDecision {
    row: number;
    col: number;
    /** 调试用：该点的评分 */
    score: number;
}

/** 棋型分值（规格要求的权重梯队）。 */
const SCORE = {
    /** 活五（成五） */
    FIVE: 1000000,
    /** 冲四 / 活四 */
    FOUR: 100000,
    /** 活三 */
    THREE: 10000,
    /** 眠三 */
    SLEEP_THREE: 1000,
    /** 活二 */
    TWO: 100,
    /** 眠二 */
    SLEEP_TWO: 10,
    /** 单子 */
    ONE: 1,
} as const;

/**
 * 攻防比：防守权重略高（1:1.2），
 * 让 AI 更倾向于堵对方的活三/冲四，符合「新手能赢但有挑战性」的定位。
 */
const DEFENSE_RATIO = 1.2;

export class GomokuAi {
    /** 自身棋子颜色。 */
    private readonly _myStone: Stone;
    /** 对手棋子颜色。 */
    private readonly _oppStone: Stone;
    private readonly _level: AiLevel;

    /**
     * @param aiPlayerId AI 的 playerId
     * @param firstPlayerId 先手（黑）
     * @param level 难度
     */
    constructor(aiPlayerId: string, firstPlayerId: string, level: AiLevel) {
        this._myStone = aiPlayerId === firstPlayerId ? BLACK : WHITE;
        this._oppStone = this._myStone === BLACK ? WHITE : BLACK;
        this._level = level;
    }

    /**
     * 计算下一步。
     *
     * @param rules 当前棋局
     * @returns 落子位置；无合法位置返回 null
     */
    public decide(rules: GomokuRules): GomokuAiDecision | null {
        const candidates = rules.candidateCells(this._level === AiLevel.EASY ? 1 : 2);
        if (candidates.length === 0) {
            // 兜底：任意空位
            const empties = rules.emptyCells();
            return empties.length > 0 ? { row: empties[0].row, col: empties[0].col, score: 0 } : null;
        }

        // ---- 第一优先级：己方直接成五（必胜手，绝不能被防守分反超） ----
        // 必须在综合评分之前独立判断，否则「防守权重 × 对手五连分」会盖过
        // 自己的成五分（例如防守分 1000000 × 1.2 = 1200000 > 1000000），
        // 导致 AI 为了堵对方而放弃自己的一步胜利。
        for (const cell of candidates) {
            const attack = this._scorePoint(rules, cell.row, cell.col, this._myStone);
            if (attack >= SCORE.FIVE) {
                return { row: cell.row, col: cell.col, score: attack };
            }
        }

        // ---- 第二优先级：对方有一步成五 → 必须封堵（否则必败） ----
        // 同样独立于防守权重：此时任何防守动作都不能被更低的评分挤掉。
        let block: GomokuAiDecision | null = null;
        for (const cell of candidates) {
            const defense = this._scorePoint(rules, cell.row, cell.col, this._oppStone);
            if (defense >= SCORE.FIVE) {
                if (!block || defense > block.score) {
                    block = { row: cell.row, col: cell.col, score: defense };
                }
            }
        }
        if (block) {
            return block;
        }

        // ---- 第三优先级：综合评分（攻防比 1:1.2，略偏防守） ----
        let best: GomokuAiDecision | null = null;

        for (const cell of candidates) {
            const attack = this._scorePoint(rules, cell.row, cell.col, this._myStone);
            const defense = this._scorePoint(rules, cell.row, cell.col, this._oppStone);
            const total = attack + defense * DEFENSE_RATIO;

            if (!best || total > best.score) {
                best = { row: cell.row, col: cell.col, score: total };
            }
        }

        return best;
    }

    /**
     * 评估在 (row,col) 落 stone 的价值。
     *
     * 做法：假设在该点放置 stone，检测四个方向上形成的棋型并取最高分。
     */
    private _scorePoint(rules: GomokuRules, row: number, col: number, stone: Stone): number {
        let best = 0;
        const dirs: Array<[number, number]> = [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1],
        ];

        for (const [dr, dc] of dirs) {
            const s = this._scoreDirection(rules, row, col, dr, dc, stone);
            if (s > best) {
                best = s;
            }
        }
        return best;
    }

    /**
     * 单方向棋型评分。
     *
     * 统计假设落子后，该方向上：
     * - 连续同色子数 count（含假设点）
     * - 两端是否开放 openEnds（0/1/2）
     * 据此映射到棋型分值。
     */
    private _scoreDirection(
        rules: GomokuRules,
        row: number,
        col: number,
        dr: number,
        dc: number,
        stone: Stone,
    ): number {
        let count = 1; // 假设点本身
        let openEnds = 0;

        // 正方向
        let blocked = false;
        for (let step = 1; step < rules.winCount; step++) {
            const r = row + dr * step;
            const c = col + dc * step;
            if (!rules.inBounds(r, c)) {
                blocked = true;
                break;
            }
            const v = rules.get(r, c);
            if (v === stone) {
                count++;
            } else if (v === 0) {
                openEnds++;
                break;
            } else {
                blocked = true;
                break;
            }
        }

        // 反方向
        for (let step = 1; step < rules.winCount; step++) {
            const r = row - dr * step;
            const c = col - dc * step;
            if (!rules.inBounds(r, c)) {
                blocked = true;
                break;
            }
            const v = rules.get(r, c);
            if (v === stone) {
                count++;
            } else if (v === 0) {
                openEnds++;
                break;
            } else {
                blocked = true;
                break;
            }
        }

        // 两端都被堵死且未成五 → 无价值
        if (openEnds === 0 && count < rules.winCount) {
            return 0;
        }
        // 越界侧不计开放（blocked 已处理），此处仅用于压制死棋
        void blocked;

        return this._mapScore(count, openEnds, rules.winCount);
    }

    /**
     * 棋型 → 分值映射。
     *
     * 参照规格权重梯队：活五 > 冲四/活四 > 活三 > 眠三 > 活二
     */
    private _mapScore(count: number, openEnds: number, winCount: number): number {
        // 已成五（或超过）
        if (count >= winCount) {
            return SCORE.FIVE;
        }
        // 四子
        if (count === 4) {
            // 双活端 = 活四（必胜）；单活端 = 冲四
            return openEnds === 2 ? SCORE.FOUR : openEnds === 1 ? SCORE.FOUR : 0;
        }
        // 三子
        if (count === 3) {
            return openEnds === 2 ? SCORE.THREE : openEnds === 1 ? SCORE.SLEEP_THREE : 0;
        }
        // 二子
        if (count === 2) {
            return openEnds === 2 ? SCORE.TWO : openEnds === 1 ? SCORE.SLEEP_TWO : 0;
        }
        // 单子
        return SCORE.ONE;
    }

    /** 模拟思考时长（毫秒）：0.8~2s 随机，规格要求。 */
    public static thinkDelayMs(): number {
        const min = 800;
        const max = 2000;
        return Math.floor(min + Math.random() * (max - min + 1));
    }
}
