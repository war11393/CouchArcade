/**
 * 寻机头 —— 飞机布局生成与权威查询。
 *
 * 规则：
 * - 棋盘 12×12；
 * - 随机分布 5 架飞机，形态矩阵（4 行 × 5 列）：
 *     [0 0 2 0 0]
 *     [1 1 1 1 1]
 *     [0 0 1 0 0]
 *     [0 1 1 1 0]
 *   2 = 机头，1 = 机身，0 = 非飞机；
 * - 开局按随机位置 + 随机朝向（0°/90°/180°/270°）放置，不得重叠、不得越界。
 *
 * 本文件实现 ILayoutProvider：布局权威方抽象。
 * 第一阶段：联机/Mock 模式由本地规则层担任权威（经 MockSync 下发翻格结果）；
 * 第二阶段：切换为云函数生成 + 加密存储，客户端始终只按格查询结果，杜绝篡改。
 */

import { AppConfig } from '../../config/AppConfig';
import { ILayoutProvider } from '../common/IGame';

/** 格子内容编码。 */
export const CELL_EMPTY = 0;
export const CELL_BODY = 1;
export const CELL_HEAD = 2;

/** 飞机基础形态（未旋转）：行 0 为机头行。 */
export const PLANE_SHAPE: readonly (readonly number[])[] = [
    [0, 0, 2, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
];

/** 朝向（顺时针角度）。 */
export type Rotation = 0 | 90 | 180 | 270;

/** 单架飞机的位置信息。 */
export interface PlanePlacement {
    /** 飞机编号 0..4 */
    index: number;
    /** 左上角放置坐标（旋转后包围盒的左上角） */
    originRow: number;
    originCol: number;
    /** 朝向 */
    rotation: Rotation;
}

/** 完整布局。 */
export interface PlaneLayout {
    size: number;
    /** 布局数组：cell[row][col]，值 0/1/2 */
    cells: number[][];
    /** cell → 飞机编号（-1 表示非飞机） */
    planeIndexAt: number[][];
    /** 每架飞机的机头坐标（服务端权威，客户端不可见） */
    heads: Array<{ row: number; col: number; planeIndex: number }>;
    /** 布局指纹（校验双端一致） */
    fingerprint: string;
}

/**
 * 确定性伪随机数生成器（mulberry32）。
 *
 * 为什么不用 Math.random：布局必须由 seed 决定，
 * 这样「服务端生成 → 客户端可校验」才能一致（第二阶段云函数同算法即可对齐）。
 */
export class Rng {
    private _state: number;

    constructor(seed: number) {
        // 保证 seed 为 32 位无符号整数
        this._state = seed >>> 0;
        if (this._state === 0) {
            this._state = 0x9e3779b9;
        }
    }

    /** 返回 [0,1) 浮点。 */
    public next(): number {
        this._state = (this._state + 0x6d2b79f5) >>> 0;
        let t = this._state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** 返回 [min,max] 整数。 */
    public int(min: number, max: number): number {
        return Math.floor(min + this.next() * (max - min + 1));
    }

    /** 从数组随机取一个元素。 */
    public pick<T>(arr: readonly T[]): T {
        return arr[this.int(0, arr.length - 1)];
    }
}

/**
 * 寻机头布局生成器（实现 ILayoutProvider）。
 */
export class PlaneHuntLayoutProvider implements ILayoutProvider {
    /** 生成布局的最大重试次数（防止死循环）。 */
    private static readonly MAX_RETRY = 400;

    /**
     * 生成 5 架飞机的布局。
     *
     * 算法：随机位置 + 随机朝向 + 碰撞检测 + 失败重试。
     */
    public generate(seed: number): PlaneLayout {
        const size = AppConfig.PLANEHUNT_SIZE;
        const planeCount = AppConfig.PLANEHUNT_PLANE_COUNT;
        const rng = new Rng(seed);

        const cells: number[][] = [];
        const planeIndexAt: number[][] = [];
        for (let r = 0; r < size; r++) {
            cells.push(new Array<number>(size).fill(CELL_EMPTY));
            planeIndexAt.push(new Array<number>(size).fill(-1));
        }

        const heads: Array<{ row: number; col: number; planeIndex: number }> = [];
        const rotations: Rotation[] = [0, 90, 180, 270];
        /** 已占用的格子集合，用于重叠检测。 */
        const occupied = new Set<number>();
        const key = (r: number, c: number): number => r * size + c;

        let placed = 0;
        let retry = 0;

        while (placed < planeCount && retry < PlaneHuntLayoutProvider.MAX_RETRY * planeCount) {
            retry++;
            const rotation = rng.pick(rotations);
            const shape = this.rotateShape(PLANE_SHAPE, rotation);
            const shapeH = shape.length;
            const shapeW = shape[0].length;

            // 随机左上角；留出边界
            const originRow = rng.int(0, size - shapeH);
            const originCol = rng.int(0, size - shapeW);

            // 越界检查（理论上 rng 已保证，仍显式校验）
            if (originRow < 0 || originCol < 0 || originRow + shapeH > size || originCol + shapeW > size) {
                continue;
            }

            // 收集本次将占用的格子
            const pending: Array<{ row: number; col: number; v: number }> = [];
            let overlap = false;
            for (let r = 0; r < shapeH && !overlap; r++) {
                for (let c = 0; c < shapeW; c++) {
                    const v = shape[r][c];
                    if (v === 0) {
                        continue;
                    }
                    const gr = originRow + r;
                    const gc = originCol + c;
                    if (occupied.has(key(gr, gc))) {
                        overlap = true;
                        break;
                    }
                    pending.push({ row: gr, col: gc, v });
                }
            }

            if (overlap) {
                continue; // 失败重试
            }

            // 提交放置
            let headRow = -1;
            let headCol = -1;
            for (const p of pending) {
                cells[p.row][p.col] = p.v;
                planeIndexAt[p.row][p.col] = placed;
                occupied.add(key(p.row, p.col));
                if (p.v === CELL_HEAD) {
                    headRow = p.row;
                    headCol = p.col;
                }
            }

            if (headRow < 0) {
                // 理论上不会发生（形态矩阵必含机头）；防御性回滚
                for (const p of pending) {
                    cells[p.row][p.col] = CELL_EMPTY;
                    planeIndexAt[p.row][p.col] = -1;
                    occupied.delete(key(p.row, p.col));
                }
                continue;
            }

            heads.push({ row: headRow, col: headCol, planeIndex: placed });
            placed++;
        }

        if (placed < planeCount) {
            console.error(
                `[PlaneHuntLayout] 布局生成失败：仅放置 ${placed}/${planeCount} 架（seed=${seed}）`,
            );
        } else if (AppConfig.LOG_VERBOSE) {
            console.log(
                `[PlaneHuntLayout] 布局生成成功：${placed} 架飞机（seed=${seed}, 重试 ${retry} 次）`,
            );
        }

        return {
            size,
            cells,
            planeIndexAt,
            heads,
            fingerprint: this._fingerprint(seed, heads),
        };
    }

    /**
     * 查询单格内容（ILayoutProvider 关键方法）。
     *
     * 客户端只能通过此方法逐格获取结果，无法拿到完整布局 ——
     * 第二阶段由云函数实现同名查询即可完全对齐。
     */
    public queryCell(layout: unknown, row: number, col: number): number {
        const l = layout as PlaneLayout;
        if (!l || !l.cells || row < 0 || row >= l.size || col < 0 || col >= l.size) {
            return CELL_EMPTY;
        }
        return l.cells[row][col];
    }

    /** 序列化（第二阶段写入云数据库；服务端应加密存储）。 */
    public serialize(layout: unknown): string {
        return JSON.stringify(layout);
    }

    /** 反序列化。 */
    public deserialize(raw: string): unknown {
        return JSON.parse(raw) as PlaneLayout;
    }

    // ==================== 内部工具 ====================

    /**
     * 旋转形态矩阵（顺时针）。
     *
     * @param shape 原始矩阵
     * @param rotation 0/90/180/270 度
     */
    public rotateShape(
        shape: readonly (readonly number[])[],
        rotation: Rotation,
    ): number[][] {
        let cur: number[][] = shape.map((row) => row.slice());
        const times = rotation / 90;
        for (let i = 0; i < times; i++) {
            cur = this._rotate90(cur);
        }
        return cur;
    }

    /** 顺时针旋转 90°：new[c][h-1-r] = old[r][c]。 */
    private _rotate90(m: number[][]): number[][] {
        const h = m.length;
        const w = m[0].length;
        const out: number[][] = [];
        for (let c = 0; c < w; c++) {
            const row: number[] = [];
            for (let r = h - 1; r >= 0; r--) {
                row.push(m[r][c]);
            }
            out.push(row);
        }
        return out;
    }

    /**
     * 布局指纹：用于双端一致性校验与防篡改检测。
     * 仅由 seed 与机头位置推导，不含明文机身信息。
     */
    private _fingerprint(seed: number, heads: Array<{ row: number; col: number }>): string {
        const s = heads
            .map((h) => `${h.row}${h.col}`)
            .sort()
            .join('-');
        let hash = 2166136261 ^ (seed >>> 0);
        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    }
}
