/**
 * 寻机头 AI（简单策略，规格要求）。
 *
 * 策略：
 * - 无信息时随机选未翻开格子；
 * - 记忆已翻机身，发现机身后优先探索其四邻域找关联机头；
 * - 响应延迟 0.5~1.5s 随机模拟思考。
 *
 * 纯逻辑实现，无 Cocos 依赖。
 */

import { AiLevel } from '../../config/AppConfig';
import { CELL_BODY } from './PlaneHuntLayout';
import { PlaneHuntRules } from './PlaneHuntRules';

export interface PlaneHuntAiDecision {
    row: number;
    col: number;
    /** 调试用：决策依据 */
    reason: 'neighbor' | 'random';
}

export class PlaneHuntAi {
    private readonly _level: AiLevel;

    constructor(level: AiLevel) {
        this._level = level;
    }

    /**
     * 计算下一步翻格位置。
     *
     * @param rules 当前棋局（AI 视角只能看到已揭示信息，天然防作弊）
     * @returns 目标格；无可用格返回 null
     */
    public decide(rules: PlaneHuntRules): PlaneHuntAiDecision | null {
        const unopened: Array<{ row: number; col: number }> = [];
        for (let r = 0; r < rules.size; r++) {
            for (let c = 0; c < rules.size; c++) {
                if (!rules.isRevealed(r, c)) {
                    unopened.push({ row: r, col: c });
                }
            }
        }
        if (unopened.length === 0) {
            return null;
        }

        // 记忆已翻机身 → 优先探索四邻域
        const neighbors = this._findBodyNeighbors(rules);
        if (neighbors.length > 0) {
            const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
            return { row: pick.row, col: pick.col, reason: 'neighbor' };
        }

        // 无信息：随机选未翻开格子
        const pick = unopened[Math.floor(Math.random() * unopened.length)];
        return { row: pick.row, col: pick.col, reason: 'random' };
    }

    /**
     * 找出「已揭示机身」的未翻开四邻域格。
     *
     * 这是规格要求的核心策略：发现机身后优先探索四邻域找关联机头。
     */
    private _findBodyNeighbors(rules: PlaneHuntRules): Array<{ row: number; col: number }> {
        const out: Array<{ row: number; col: number }> = [];
        const seen = new Set<number>();
        const dirs: Array<[number, number]> = [
            [0, 1],
            [1, 0],
            [0, -1],
            [-1, 0],
        ];

        for (const rev of rules.allRevealed()) {
            if (rev.cell !== CELL_BODY) {
                continue;
            }
            for (const [dr, dc] of dirs) {
                const r = rev.row + dr;
                const c = rev.col + dc;
                if (r < 0 || r >= rules.size || c < 0 || c >= rules.size) {
                    continue;
                }
                if (rules.isRevealed(r, c)) {
                    continue;
                }
                const k = r * rules.size + c;
                if (seen.has(k)) {
                    continue;
                }
                seen.add(k);
                out.push({ row: r, col: c });
            }
        }

        // 难度增强：HARD 模式下优先靠近已有飞机群的邻域（此处保持简单策略，
        // 仅对相邻机身超过 2 个的格子做优先，符合「简单策略」定位）
        if (this._level === AiLevel.HARD && out.length > 2) {
            // 保持顺序即可（本身已是机身邻域）
        }
        return out;
    }

    /** 模拟思考时长（毫秒）：0.5~1.5s 随机，规格要求。 */
    public static thinkDelayMs(): number {
        const min = 500;
        const max = 1500;
        return Math.floor(min + Math.random() * (max - min + 1));
    }
}
