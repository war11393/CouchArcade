/**
 * 五子棋规则逻辑（纯 TypeScript，无任何 Cocos 依赖，可单元测试）。
 *
 * 棋盘 15×15，交叉点落子，黑先白后，横/竖/双斜先连五者胜，MVP 无禁手。
 *
 * 设计要点：
 * - 与表现层完全分离：本文件只维护「棋盘数组 + 回合 + 胜负」；
 * - 高效五连检测：只检测最后落子点的四个方向（O(4×9)），不遍历全盘。
 */

import { AppConfig } from '../../config/AppConfig';

/** 棋子颜色。0 = 空，1 = 黑，2 = 白。 */
export type Stone = 0 | 1 | 2;

/** 落子动作。 */
export interface GomokuMove {
    row: number;
    col: number;
    /** 落子方 playerId */
    playerId: string;
    stone: Stone;
}

/** 胜负判定结果。 */
export interface WinCheck {
    win: boolean;
    /** 获胜连线坐标（用于高亮），未获胜为空数组 */
    line: Array<{ row: number; col: number }>;
}

export const BLACK: Stone = 1;
export const WHITE: Stone = 2;

/**
 * 五子棋棋盘状态机。
 *
 * 线程/时序约定：本类不做任何异步，所有变更同步生效，
 * 由调用方（权威裁判）决定何时应用，因此天然可单测。
 */
export class GomokuRules {
    public readonly size: number;
    public readonly winCount: number;

    /** 棋盘数组，索引 = row * size + col。 */
    private _board: Stone[];
    /** 当前该谁落子（playerId）。 */
    private _currentPlayerId: string;
    /** 各玩家的棋子颜色映射。 */
    private readonly _stoneOf = new Map<string, Stone>();
    /** 已落子步数（判断和棋）。 */
    private _moves = 0;
    /** 最后一步（UI 高亮用）。 */
    private _lastMove: GomokuMove | null = null;
    /** 已结束标记。 */
    private _finished = false;
    /** 胜者 playerId（无则空）。 */
    private _winnerId = '';
    /** 是否平局。 */
    private _draw = false;
    /** 获胜连线。 */
    private _winLine: Array<{ row: number; col: number }> = [];
    /** 落子历史（回放/结算数据）。 */
    private readonly _history: GomokuMove[] = [];

    /**
     * @param firstPlayerId 先手玩家（黑）
     * @param secondPlayerId 后手玩家（白）
     */
    constructor(firstPlayerId: string, secondPlayerId: string) {
        this.size = AppConfig.GOMOKU_SIZE;
        this.winCount = AppConfig.GOMOKU_WIN_COUNT;
        this._board = new Array<Stone>(this.size * this.size).fill(0);
        this._stoneOf.set(firstPlayerId, BLACK);
        this._stoneOf.set(secondPlayerId, WHITE);
        this._currentPlayerId = firstPlayerId;
    }

    // ==================== 查询 ====================

    /** 读取某格。 */
    public get(row: number, col: number): Stone {
        if (!this.inBounds(row, col)) {
            return 0;
        }
        return this._board[row * this.size + col];
    }

    /** 某玩家的棋子颜色。 */
    public stoneOf(playerId: string): Stone {
        return this._stoneOf.get(playerId) ?? 0;
    }

    /** 对手 playerId。 */
    public opponentOf(playerId: string): string {
        for (const id of this._stoneOf.keys()) {
            if (id !== playerId) {
                return id;
            }
        }
        return '';
    }

    public get currentPlayerId(): string {
        return this._currentPlayerId;
    }

    public get lastMove(): GomokuMove | null {
        return this._lastMove;
    }

    public get moveCount(): number {
        return this._moves;
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

    public get winLine(): Array<{ row: number; col: number }> {
        return this._winLine;
    }

    public get history(): ReadonlyArray<GomokuMove> {
        return this._history;
    }

    public inBounds(row: number, col: number): boolean {
        return row >= 0 && row < this.size && col >= 0 && col < this.size;
    }

    /**
     * 落子合法性校验（规格要求）。
     * @returns null 表示合法；否则返回错误原因
     */
    public validateMove(row: number, col: number, playerId: string): string | null {
        if (this._finished) {
            return '对局已结束';
        }
        if (!this.inBounds(row, col)) {
            return `落子越界 (${row},${col})`;
        }
        if (playerId !== this._currentPlayerId) {
            return '未轮到该玩家落子';
        }
        if (this._board[row * this.size + col] !== 0) {
            return '该位置已有棋子';
        }
        return null;
    }

    /** 全部空位（AI 遍历用）。 */
    public emptyCells(): Array<{ row: number; col: number }> {
        const out: Array<{ row: number; col: number }> = [];
        for (let r = 0; r < this.size; r++) {
            for (let c = 0; c < this.size; c++) {
                if (this._board[r * this.size + c] === 0) {
                    out.push({ row: r, col: c });
                }
            }
        }
        return out;
    }

    /** 附近有空位的格子（AI 剪枝：只考虑已有棋子周围的空位）。 */
    public candidateCells(radius = 2): Array<{ row: number; col: number }> {
        if (this._moves === 0) {
            const mid = Math.floor(this.size / 2);
            return [{ row: mid, col: mid }];
        }
        const seen = new Set<number>();
        const out: Array<{ row: number; col: number }> = [];
        for (let r = 0; r < this.size; r++) {
            for (let c = 0; c < this.size; c++) {
                if (this._board[r * this.size + c] === 0) {
                    continue;
                }
                for (let dr = -radius; dr <= radius; dr++) {
                    for (let dc = -radius; dc <= radius; dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (!this.inBounds(nr, nc)) {
                            continue;
                        }
                        const idx = nr * this.size + nc;
                        if (this._board[idx] !== 0 || seen.has(idx)) {
                            continue;
                        }
                        seen.add(idx);
                        out.push({ row: nr, col: nc });
                    }
                }
            }
        }
        return out;
    }

    // ==================== 变更 ====================

    /**
     * 应用一步落子。
     *
     * @returns 是否成功；失败时不变更任何状态（原子性）
     */
    public applyMove(row: number, col: number, playerId: string): boolean {
        const err = this.validateMove(row, col, playerId);
        if (err !== null) {
            console.warn(`[GomokuRules] 非法落子: ${err}`);
            return false;
        }

        const stone = this.stoneOf(playerId);
        this._board[row * this.size + col] = stone;
        this._moves++;

        const move: GomokuMove = { row, col, playerId, stone };
        this._lastMove = move;
        this._history.push(move);

        // 高效五连检测：只检测落子点四方向
        const check = this.checkWinAt(row, col);
        if (check.win) {
            this._finished = true;
            this._winnerId = playerId;
            this._winLine = check.line;
            return true;
        }

        // 和棋：棋盘下满
        if (this._moves >= this.size * this.size) {
            this._finished = true;
            this._draw = true;
            return true;
        }

        // 切换回合
        this._currentPlayerId = this.opponentOf(playerId);
        return true;
    }

    /**
     * 撤销最后一步（**仅供预落子回滚**使用，见 GomokuGame 的乐观渲染说明）。
     *
     * 规则上五子棋不允许悔棋 —— 本方法不是给玩家用的，而是：客户端为了手感
     * 把「自己这一手」先行落上棋盘（权威结果到达前），若权威方拒绝了这一手
     * （SYS_ERROR），必须能把这颗「假子」干净地摘掉，否则本地状态与权威永久分叉。
     *
     * ⚠️ 必须还原 applyMove 动过的**全部**状态：_board / _moves / _history /
     *    _lastMove / _currentPlayerId（回到落子方的回合）。少还原一个字段，
     *    下一次权威落子就会把「已回滚的格子」当成有子而跳过（幂等短路）
     *    或把回合算错 —— 都是极难查的「看不出问题」级 bug。
     *
     * @returns 被撤销的那一步（无棋可撤时 null）
     */
    public undoLastMove(): GomokuMove | null {
        const move = this._history.pop();
        if (!move) {
            return null;
        }
        this._board[move.row * this.size + move.col] = 0;
        this._moves--;
        this._finished = false;
        this._winnerId = '';
        this._draw = false;
        this._winLine = [];
        this._lastMove = this._history.length > 0
            ? this._history[this._history.length - 1]
            : null;
        this._currentPlayerId = move.playerId;
        return move;
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
     * 高效五连检测：仅检测 (row,col) 落子点的四个方向。
     *
     * 复杂度 O(4 × winCount)，不遍历全盘，满足规格「高效五连检测」要求。
     */
    public checkWinAt(row: number, col: number): WinCheck {
        const stone = this.get(row, col);
        if (stone === 0) {
            return { win: false, line: [] };
        }

        // 四个方向：水平、垂直、主对角(↘)、副对角(↗)
        const dirs: Array<[number, number]> = [
            [0, 1],
            [1, 0],
            [1, 1],
            [1, -1],
        ];

        for (const [dr, dc] of dirs) {
            const line: Array<{ row: number; col: number }> = [{ row, col }];

            // 正方向延伸
            for (let step = 1; step < this.winCount; step++) {
                const r = row + dr * step;
                const c = col + dc * step;
                if (this.get(r, c) !== stone) {
                    break;
                }
                line.push({ row: r, col: c });
            }
            // 反方向延伸
            for (let step = 1; step < this.winCount; step++) {
                const r = row - dr * step;
                const c = col - dc * step;
                if (this.get(r, c) !== stone) {
                    break;
                }
                line.push({ row: r, col: c });
            }

            if (line.length >= this.winCount) {
                return { win: true, line };
            }
        }
        return { win: false, line: [] };
    }

    /** 序列化（用于同步/持久化，服务端权威存储）。 */
    public serialize(): string {
        return JSON.stringify({
            size: this.size,
            board: this._board,
            currentPlayerId: this._currentPlayerId,
            moves: this._moves,
            finished: this._finished,
            winnerId: this._winnerId,
            draw: this._draw,
        });
    }

    /** 从序列化数据恢复（断线重连用）。 */
    public static deserialize(raw: string, firstPlayerId: string, secondPlayerId: string): GomokuRules {
        const data = JSON.parse(raw) as {
            board: Stone[];
            currentPlayerId: string;
            moves: number;
            finished: boolean;
            winnerId: string;
            draw: boolean;
        };
        const rules = new GomokuRules(firstPlayerId, secondPlayerId);
        // 直接覆写内部状态（恢复场景专用）
        (rules as unknown as { _board: Stone[] })._board = data.board;
        (rules as unknown as { _currentPlayerId: string })._currentPlayerId = data.currentPlayerId;
        (rules as unknown as { _moves: number })._moves = data.moves;
        (rules as unknown as { _finished: boolean })._finished = data.finished;
        (rules as unknown as { _winnerId: string })._winnerId = data.winnerId;
        (rules as unknown as { _draw: boolean })._draw = data.draw;
        return rules;
    }

    /** 调试用：以文本形式打印棋盘。 */
    public dump(): string {
        const lines: string[] = [];
        for (let r = 0; r < this.size; r++) {
            let line = '';
            for (let c = 0; c < this.size; c++) {
                const s = this.get(r, c);
                line += s === 0 ? '.' : s === BLACK ? 'X' : 'O';
            }
            lines.push(line);
        }
        return lines.join('\n');
    }
}
