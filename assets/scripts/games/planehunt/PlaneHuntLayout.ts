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
    /**
     * 回溯搜索的节点预算（防止极端输入下卡死）。
     *
     * 取值理由（2026-09-25 实测）：10×10 放 5 架十字战机，
     * 正确实现下**首个解通常只需几十个节点**；给到 20 万是极宽的余量，
     * 正常永远不会触顶。它只是「万一将来改棋盘/机型导致无解」时的刹车。
     */
    private static readonly MAX_NODES = 200000;

    /**
     * 生成 5 架飞机的布局。
     *
     * ── 算法：**回溯搜索**（2026-09-25 重写）──
     *
     * 旧实现是「随机撒点 + 碰撞检测 + 失败重试（上限 400×架数）」，
     * 实测**灾难性**：5000 个 seed 里只有 26.5% 能放满 5 架 ——
     *   3 架 5.3% ｜ 4 架 68.2% ｜ 5 架 26.5%
     * 而棋盘占用率才 50 格/100 格。也就是说**空间根本够**，
     * 是随机撒点会把棋盘切碎成容不下剩余飞机的小块，之后的重试全在死路上撞。
     * 后果不只是难看：机头总数决定「何时结束」，少一架等于白送一局。
     *
     * 现在改为：把「(朝向, 左上角)」的全部合法摆放位置按 rng **洗牌**后
     * 深度优先尝试，放不下就回退。这样既保留随机观感（同 seed 结果确定），
     * 又**在解存在时必然找到**——不再有「概率性残缺布局」。
     *
     * 确定性保证（双端一致性依赖它）：全程只用传入 seed 构造的 rng，
     * 且洗牌/尝试顺序完全由它决定 ⇒ 同 seed 必得同布局。
     * ⚠️ 本算法在 cloudfunctions/startGame/index.js 有一份**逐字等价**的实现
     *    （云函数不能用 TS），改这里必须同步改那边，否则客户端影子布局
     *    与权威布局不一致 —— 玩家会看到「翻开的格子与权威判定对不上」。
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
        /** 已占用的**实体格**集合（唯一可行约束，见下方 placements 的说明）。 */
        const occupied = new Set<number>();
        const key = (r: number, c: number): number => r * size + c;

        // ── 1) 枚举全部候选摆放 ──
        // 每个候选 = 一种朝向 + 一个左上角，附带它要占的实体格。
        // 只保留「不越界」的候选；重叠在搜索时动态判断（随占用变化）。
        interface Placement {
            rotation: Rotation;
            shape: number[][];
            originRow: number;
            originCol: number;
            /** 实体格坐标（含值为 1/2 的格）。 */
            cellsAt: Array<{ row: number; col: number; v: number }>;
        }
        const placements: Placement[] = [];
        const rotations: Rotation[] = [0, 90, 180, 270];
        for (const rotation of rotations) {
            const shape = this.rotateShape(PLANE_SHAPE, rotation);
            const shapeH = shape.length;
            const shapeW = shape[0].length;
            for (let originRow = 0; originRow + shapeH <= size; originRow++) {
                for (let originCol = 0; originCol + shapeW <= size; originCol++) {
                    const cellsAt: Array<{ row: number; col: number; v: number }> = [];
                    for (let r = 0; r < shapeH; r++) {
                        for (let c = 0; c < shapeW; c++) {
                            const v = shape[r][c];
                            if (v === 0) {
                                continue;
                            }
                            cellsAt.push({ row: originRow + r, col: originCol + c, v });
                        }
                    }
                    placements.push({ rotation, shape, originRow, originCol, cellsAt });
                }
            }
        }

        // ── 2) 洗牌（Fisher-Yates，用 rng 保证确定性）──
        // 洗一次即可：回溯会按这个固定顺序深度优先尝试。
        // 为什么不每层重新洗：那样同一 seed 的结果会依赖搜索路径，
        // 难以复现、也不便两端比对。固定顺序 + 回溯已足够产生随机观感。
        for (let i = placements.length - 1; i > 0; i--) {
            const j = rng.int(0, i);
            const tmp = placements[i];
            placements[i] = placements[j];
            placements[j] = tmp;
        }

        // ── 3) 深度优先 + 回退 ──
        /** 已选中的摆放（按放置顺序）。 */
        const chosen: Placement[] = [];
        /** 搜索节点计数（预算保护）。 */
        let nodes = 0;
        /** 是否因预算耗尽而中止（用于区分「无解」与「没搜完」）。 */
        let budgetExhausted = false;

        const canPlace = (p: Placement): boolean => {
            for (const cell of p.cellsAt) {
                if (occupied.has(key(cell.row, cell.col))) {
                    return false;
                }
            }
            return true;
        };
        const doPlace = (p: Placement): void => {
            for (const cell of p.cellsAt) {
                occupied.add(key(cell.row, cell.col));
            }
        };
        const undoPlace = (p: Placement): void => {
            for (const cell of p.cellsAt) {
                occupied.delete(key(cell.row, cell.col));
            }
        };

        /**
         * 尝试放第 idx 架，成功返回 true。
         *
         * 剪枝：候选按洗牌顺序线性扫描 —— 不做「按剩余空间」的启发式排序，
         * 因为那会引入额外状态、让两端实现更容易漂移；本棋盘规模下
         * 朴素回溯已经足够快（实测首个解几十个节点）。
         *
         * ⚠️ 计数口径（2026-09-25 踩过）：`nodes` **只在真正尝试放置时**自增，
         *    不能对每个被 canPlace 拒绝的候选都计数。placements 有约 190 个项目，
         *    若连拒绝也计数，5 层搜索里无效访问会把预算瞬间吃光 →
         *    search 在第一层就返回 false → **一架都放不下（0 个机头）**。
         *    那比原来的概率性残缺更糟，是本次修正的直接原因。
         */
        const search = (idx: number): boolean => {
            if (idx >= planeCount) {
                return true;
            }
            for (const p of placements) {
                if (!canPlace(p)) {
                    continue;
                }
                // 只有「确实产生了分支」才算一个搜索节点
                nodes++;
                if (nodes > PlaneHuntLayoutProvider.MAX_NODES) {
                    budgetExhausted = true;
                    return false;
                }
                doPlace(p);
                chosen.push(p);
                if (search(idx + 1)) {
                    return true;
                }
                chosen.pop();
                undoPlace(p);
            }
            return false;
        };

        const solved = search(0);
        if (!solved && !budgetExhausted) {
            // 搜索完整走完仍放不下 —— 说明约束本身与棋盘不相容（真·无解）。
            // 正常情况下不该出现；出现即需重新评估尺寸/架数/形态。
            console.error(
                `[PlaneHuntLayout] 布局无解（seed=${seed}，节点=${nodes}）：` +
                    `${size}×${size} 放不下 ${planeCount} 架且搜索已穷尽`,
            );
        }

        // ── 4) 落盘（无论是否放满都写出已放置部分，保持旧行为可观测）──
        for (let i = 0; i < chosen.length; i++) {
            const p = chosen[i];
            let headRow = -1;
            let headCol = -1;
            for (const cell of p.cellsAt) {
                cells[cell.row][cell.col] = cell.v;
                planeIndexAt[cell.row][cell.col] = i;
                if (cell.v === CELL_HEAD) {
                    headRow = cell.row;
                    headCol = cell.col;
                }
            }
            if (headRow < 0) {
                // 理论上不会发生（形态矩阵必含机头）；防御性跳过
                continue;
            }
            heads.push({ row: headRow, col: headCol, planeIndex: i });
        }

        const placed = heads.length;
        if (placed < planeCount) {
            // ⚠️ 这是**缺陷级**信号，不是普通警告：机头总数决定何时结束，
            //    少一架会让对局提前结束/比分失真。用 error 级别 + 明确后果描述。
            console.error(
                `[PlaneHuntLayout] 布局生成失败：仅放置 ${placed}/${planeCount} 架（seed=${seed}，` +
                    `节点=${nodes}${budgetExhausted ? '，已耗尽预算' : '，搜索完整无解'}）——` +
                    '本轮机头总数将是 ' +
                    placed +
                    '，对局会据此提前结束。请检查棋盘尺寸/飞机数与形态是否仍相容。',
            );
        } else if (AppConfig.LOG_VERBOSE) {
            console.log(
                `[PlaneHuntLayout] 布局生成成功：${placed} 架飞机（seed=${seed}, 节点 ${nodes}）`,
            );
        }

        const layout: PlaneLayout = {
            size,
            cells,
            planeIndexAt,
            heads,
            fingerprint: this._fingerprint(seed, heads),
        };

        // ★ 先打印「可核对的两端对账指纹」——这是排查「dump 与真实棋盘对不上」
        //   的第一入口，必须在 dump 之前、且**无条件**打印（不受 LOG_VERBOSE 影响）。
        //
        // 为什么单列一行（2026-09-25 用户实测踩坑）：
        //   用户按客户端 dump 的棋盘去真实对局里找机头，位置完全对不上。
        //   但两端的生成算法与产物校验当时都是绿的 —— 根因是
        //   **客户端构建产物（build/wechatgame）仍是旧算法**，而云端已部署新版；
        //   两端算同一 seed 得到不同布局，而客户端此前**从不打印自己的
        //   fingerprint**，导致这种「版本错配」在日志上完全看不出来
        //   （云函数那边一直有打印，无处比对）。
        //   现在两端都打印 fp，对不上就是版本错配，一眼可判。
        console.log(
            `[PlaneHuntLayout] 本地影子布局 seed=${seed} 机头数=${heads.length} ` +
                `fingerprint=${layout.fingerprint} —— 必须与云函数 startGame 日志里的 ` +
                'fingerprint 相同；不同 = 两端算法版本不一致（多半是客户端产物未重新构建）',
        );

        // 打印完整棋盘（人工核对形态用）。
        // ⚠️ 这是**客户端本地**那份（由 seed 推导的影子布局），
        //    翻格结果仍以云端权威下发为准；但核对「形态对不对」看这份即可
        //    —— 两端用同一套生成算法，正常应完全一致。
        this.dumpLayout(layout, seed);

        return layout;
    }

    /**
     * 把完整布局打成 ASCII 图输出到控制台（人工核对用）。
     *
     * 图例： `H` 机头(2)   `#` 机身(1)   `·` 空格(0)
     *
     * 三块内容：
     *   ① 内容图（带行列号）
     *   ② 归属图：同一字母 = 同一架飞机 —— 「形态错」与「两架挨在一起
     *      看着像一架」在内容图上长得一模一样，只有按编号才分得清
     *   ③ 逐架明细 + 格数自检（基准 10 格 = 1 机头 + 9 机身，异常打 ⚠️）
     */
    public dumpLayout(layout: PlaneLayout, seed: number): void {
        const { size, cells, planeIndexAt, heads } = layout;
        const LETTERS = 'abcdefghij';
        const header = `${Array.from({ length: size }, (_, c) => String(c % 10)).join(' ')}`;

        const lines: string[] = [];
        lines.push(`[PlaneHuntLayout] ===== 布局 dump seed=${seed} ${size}×${size} =====`);
        lines.push('[PlaneHuntLayout] 图例： H=机头(2)  #=机身(1)  ·=空格(0)');
        lines.push(`[PlaneHuntLayout]      ${header}`);
        for (let r = 0; r < size; r++) {
            const row = cells[r]
                .map((v) => (v === CELL_HEAD ? 'H' : v === CELL_BODY ? '#' : '·'))
                .join(' ');
            lines.push(`[PlaneHuntLayout] ${String(r).padStart(2, ' ')} | ${row}`);
        }

        lines.push('[PlaneHuntLayout] ---- 按飞机编号（同一字母 = 同一架）----');
        lines.push(`[PlaneHuntLayout]      ${header}`);
        for (let r = 0; r < size; r++) {
            const row = planeIndexAt[r]
                .map((i) => (i >= 0 ? LETTERS[i % LETTERS.length] : '·'))
                .join(' ');
            lines.push(`[PlaneHuntLayout] ${String(r).padStart(2, ' ')} | ${row}`);
        }

        const expected = PLANE_SHAPE.reduce((n, row) => n + row.filter((v: number) => v !== 0).length, 0);
        lines.push(`[PlaneHuntLayout] ---- 各架明细（基准 ${expected} 格 = 1 机头 + ${expected - 1} 机身）----`);
        let bad = 0;
        for (let i = 0; i < heads.length; i++) {
            let body = 0;
            for (let r = 0; r < size; r++) {
                for (let c = 0; c < size; c++) {
                    if (planeIndexAt[r][c] === i && cells[r][c] === CELL_BODY) {
                        body++;
                    }
                }
            }
            const total = body + 1;
            const flag = total === expected ? '' : '  ⚠️ 格数异常！';
            if (flag) {
                bad++;
            }
            lines.push(
                `[PlaneHuntLayout]   第 ${i} 架(${LETTERS[i % LETTERS.length]}): 机头=(${heads[i].row},${heads[i].col}) 机身=${body} 合计=${total}${flag}`,
            );
        }
        lines.push(
            bad > 0
                ? `[PlaneHuntLayout] ⚠️ 有 ${bad} 架格数不等于基准 —— 形态矩阵或放置逻辑有问题`
                : `[PlaneHuntLayout] ✅ 全部 ${heads.length} 架格数正常`,
        );

        console.log(lines.join('\n'));
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
