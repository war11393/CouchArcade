/**
 * 寻机头规则逻辑（纯 TypeScript，无 Cocos 依赖，可单元测试）。
 *
 * 规则：
 * - 棋盘 12×12，双方轮流点击翻格子；
 * - 翻到机头：计入当前玩家得分，**回合照常交给对手**（不奖励连翻）；
 * - 翻到机身：仅揭示，回合结束；
 * - 翻到空格：无收获，回合结束；
 * - 胜负：5 个机头全部翻出后结束，机头多者胜，相同为平局。
 *
 * ⚠️ 关于「不奖励连翻」：早期实现让翻中机头的一方连翻一次。
 *    实测体验是「一方连翻、对手干等」，回合归属在 UI 上很难看懂，
 *    且与「交替行动」的直觉不符，故改为**翻到机头也换手**。
 *    `extraTurn` 字段保留在协议里恒为 false，是为了不破坏既有的消息结构
 *    （前端仍会读它来决定是否弹「再翻一次」提示）。
 *
 * 权威模型：本类由「权威裁判」持有（联机/Mock 模式在本地规则层，
 * 第二阶段在云函数），客户端只提交翻格请求并接收结果。
 */

import { AppConfig } from '../../config/AppConfig';
import { CELL_EMPTY, CELL_HEAD, PlaneHuntLayoutProvider, PlaneLayout } from './PlaneHuntLayout';

/** 单格揭示状态。 */
export interface RevealedCell {
    row: number;
    col: number;
    /** 0=空 1=机身 2=机头 */
    cell: number;
    /** 揭示它的玩家 */
    byPlayerId: string;
    /** 所属飞机编号（-1 表示非飞机） */
    planeIndex: number;
}

/** 翻格结果（下发/回传给客户端的权威结果）。 */
export interface FlipResult {
    row: number;
    col: number;
    cell: number;
    /** 翻开该格的玩家（UI 归属用；与 nextPlayerId 不同：翻中机头会连翻，回合不变） */
    byPlayerId: string;
    scored: boolean;
    extraTurn: boolean;
    headsFound: number;
    score: number;
    nextPlayerId: string;
    planeIndex: number;
}

/** 得分统计。 */
export interface ScoreEntry {
    playerId: string;
    score: number;
    moves: number;
}

export class PlaneHuntRules {
    public readonly size: number;
    public readonly planeCount: number;

    private readonly _provider: PlaneHuntLayoutProvider;
    private readonly _layout: PlaneLayout;
    /** 已揭示格子（row*size+col → 揭示信息） */
    private readonly _revealed = new Map<number, RevealedCell>();
    /** 已翻出的机头数 */
    private _headsFound = 0;
    /** 各玩家得分 */
    private readonly _scores = new Map<string, number>();
    /** 各玩家翻格次数 */
    private readonly _moves = new Map<string, number>();
    /** 当前该谁行动 */
    private _currentPlayerId: string;
    /** 已结束 */
    private _finished = false;
    /** 胜者（平局为空） */
    private _winnerId = '';
    /** 平局 */
    private _draw = false;
    /** 最后一次翻格结果（UI 动画用） */
    private _lastResult: FlipResult | null = null;

    constructor(
        firstPlayerId: string,
        secondPlayerId: string,
        seed: number,
        provider?: PlaneHuntLayoutProvider,
    ) {
        this.size = AppConfig.PLANEHUNT_SIZE;
        this.planeCount = AppConfig.PLANEHUNT_PLANE_COUNT;
        this._provider = provider ?? new PlaneHuntLayoutProvider();
        this._layout = this._provider.generate(seed) as PlaneLayout;

        // ⚠️ 防呆：两名玩家 id 必须不同，否则 opponentOf() 永远返回空字符串，
        //    回合交接会静默失效（nextPlayerId=''),表现为「点了棋盘没反应」。
        //    真实踩坑：上层把 myPlayerId 同时当 firstPlayerId 和 secondPlayerId 传。
        if (!secondPlayerId || secondPlayerId === firstPlayerId) {
            console.error(
                `[PlaneHuntRules] 构造参数异常：两名玩家 id 相同或为空 ` +
                    `(first='${firstPlayerId}' second='${secondPlayerId}')。` +
                    `回合将无法交接，请检查调用方实参顺序。`,
            );
        }

        this._scores.set(firstPlayerId, 0);
        this._scores.set(secondPlayerId, 0);
        this._moves.set(firstPlayerId, 0);
        this._moves.set(secondPlayerId, 0);
        this._currentPlayerId = firstPlayerId;
    }

    // ==================== 查询 ====================

    public get currentPlayerId(): string {
        return this._currentPlayerId;
    }

    public get headsFound(): number {
        return this._headsFound;
    }

    public get finished(): boolean {
        return this._finished;
    }

    public get winnerId(): string {
        return this._winnerId;
    }

    public get isDraw(): boolean {
        return this._draw;
    }

    public get lastResult(): FlipResult | null {
        return this._lastResult;
    }

    /** 该格是否已揭示。 */
    public isRevealed(row: number, col: number): boolean {
        return this._revealed.has(row * this.size + col);
    }

    /** 获取已揭示信息。 */
    public getRevealed(row: number, col: number): RevealedCell | null {
        return this._revealed.get(row * this.size + col) ?? null;
    }

    /** 全部已揭示格子（UI 重绘用）。 */
    public allRevealed(): RevealedCell[] {
        return Array.from(this._revealed.values());
    }

    /** 某玩家得分。 */
    public scoreOf(playerId: string): number {
        return this._scores.get(playerId) ?? 0;
    }

    /** 某玩家翻格次数。 */
    public movesOf(playerId: string): number {
        return this._moves.get(playerId) ?? 0;
    }

    /** 得分统计（结算用）。 */
    public allScores(): ScoreEntry[] {
        const out: ScoreEntry[] = [];
        this._scores.forEach((score, playerId) => {
            out.push({ playerId, score, moves: this._moves.get(playerId) ?? 0 });
        });
        return out;
    }

    /** 对手 id。 */
    public opponentOf(playerId: string): string {
        for (const id of this._scores.keys()) {
            if (id !== playerId) {
                return id;
            }
        }
        return '';
    }

    /** 布局指纹（双端一致性校验）。 */
    public get fingerprint(): string {
        return this._layout.fingerprint;
    }

    /** 机头总数（用于进度显示）。 */
    public get totalHeads(): number {
        return this._layout.heads.length;
    }

    // ==================== 变更 ====================

    /**
     * 校验翻格请求是否合法。
     * @returns null 表示合法
     */
    public validateFlip(row: number, col: number, playerId: string): string | null {
        if (this._finished) {
            return '对局已结束';
        }
        if (row < 0 || row >= this.size || col < 0 || col >= this.size) {
            return `翻格越界 (${row},${col})`;
        }
        if (playerId !== this._currentPlayerId) {
            return '未轮到该玩家翻格';
        }
        if (this.isRevealed(row, col)) {
            return '该格已翻开';
        }
        return null;
    }

    /**
     * 执行翻格（权威判定）。
     *
     * @returns 权威结果；非法请求返回 null
     */
    public applyFlip(row: number, col: number, playerId: string): FlipResult | null {
        const err = this.validateFlip(row, col, playerId);
        if (err !== null) {
            console.warn(`[PlaneHuntRules] 非法翻格: ${err}`);
            return null;
        }

        const cell = this._layout.cells[row][col];
        const planeIndex = this._layout.planeIndexAt[row][col];

        this._revealed.set(row * this.size + col, {
            row,
            col,
            cell,
            byPlayerId: playerId,
            planeIndex,
        });
        this._moves.set(playerId, (this._moves.get(playerId) ?? 0) + 1);

        const scored = cell === CELL_HEAD;
        if (scored) {
            this._scores.set(playerId, (this._scores.get(playerId) ?? 0) + 1);
            this._headsFound++;
        }

        // 机头全部翻出 → 结束
        if (this._headsFound >= this._layout.heads.length) {
            this._finish();
        }

        // 回合交接：无论翻到什么（机头/机身/空），只要对局未结束就换手。
        // 不再有「翻中机头奖励连翻」—— 见文件头的规则说明。
        if (!this._finished) {
            this._currentPlayerId = this.opponentOf(playerId);
        }

        const result: FlipResult = {
            row,
            col,
            cell,
            byPlayerId: playerId,
            scored,
            // 恒为 false：保留字段以兼容既有消息结构，前端据此不弹「再翻一次」
            extraTurn: false,
            headsFound: this._headsFound,
            score: this._scores.get(playerId) ?? 0,
            nextPlayerId: this._currentPlayerId,
            planeIndex,
        };
        this._lastResult = result;
        return result;
    }

    /** 投降判负。 */
    public surrender(playerId: string): void {
        if (this._finished) {
            return;
        }
        this._finished = true;
        this._winnerId = this.opponentOf(playerId);
    }

    /**
     * 结束对局：机头多者胜，相同平局。
     */
    private _finish(): void {
        this._finished = true;
        let max = -1;
        let leader = '';
        let tie = false;
        this._scores.forEach((score, playerId) => {
            if (score > max) {
                max = score;
                leader = playerId;
                tie = false;
            } else if (score === max) {
                tie = true;
            }
        });
        if (tie) {
            this._draw = true;
            this._winnerId = '';
        } else {
            this._winnerId = leader;
        }
    }

    /**
     * 权威方视图：全部机头坐标（仅服务端/权威裁判可访问）。
     * 客户端代码绝不能调用（第一阶段由 MockRoomService 内的权威对象持有）。
     */
    public authoritativeHeads(): Array<{ row: number; col: number; planeIndex: number }> {
        return this._layout.heads.slice();
    }

    /** 调试：打印已揭示棋盘。 */
    public dump(): string {
        const lines: string[] = [];
        for (let r = 0; r < this.size; r++) {
            let line = '';
            for (let c = 0; c < this.size; c++) {
                const rev = this.getRevealed(r, c);
                if (!rev) {
                    line += '? ';
                } else if (rev.cell === CELL_HEAD) {
                    line += 'H ';
                } else if (rev.cell === CELL_EMPTY) {
                    line += '. ';
                } else {
                    line += 'B ';
                }
            }
            lines.push(line);
        }
        return lines.join('\n');
    }

    /** 提供者引用（序列化布局用）。 */
    public get provider(): PlaneHuntLayoutProvider {
        return this._provider;
    }

    /** 布局引用（仅权威方内部使用）。 */
    public get layout(): PlaneLayout {
        return this._layout;
    }
}
