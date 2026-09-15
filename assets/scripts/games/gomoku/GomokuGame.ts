/**
 * 五子棋对局模块（实现 IGame）。
 *
 * 双模式共用同一套规则与 UI，仅数据源不同：
 * - pvp（联机）：本地落子 → INetSyncService.send → 等待下行权威结果 → 更新棋盘；
 * - ai（AI 练习）：完全相同的流程，但 INetSyncService 是 MockNetSync，
 *   对手由内部 AI 驱动并经同一协议通道回传 —— 业务层代码零差异。
 *
 * 视图渲染委托给 GomokuBoard（Cocos 组件），本类只管理规则状态与同步。
 */

import { AiLevel } from '../../config/AppConfig';
import { GameId } from '../../config/GameList';
import { INetSyncService, NetMessage } from '../../core/services/IServices';
import { Cmd, GkMoveResultPayload } from '../../core/protocol/Protocol';
import { GameContext, GameMode, GameResult, IGame } from '../common/IGame';
import { IMockAuthority } from '../../core/services/mock/MockNetSyncService';
import { services } from '../../core/ServiceLocator';
import { GomokuAi } from './GomokuAi';
import { GomokuRules, Stone } from './GomokuRules';
import { GomokuBoard } from './GomokuBoard';

/**
 * 五子棋权威裁判（Mock 阶段由本地规则层担任）。
 *
 * 关键：它接收「上行请求」，返回「下行消息数组」，
 * 与真实服务器（云函数）的输入输出结构完全一致。
 */
export class GomokuAuthority implements IMockAuthority {
    private readonly _rules: GomokuRules;
    private readonly _ai: GomokuAi | null;
    private readonly _aiPlayerId: string;
    private readonly _opponentId: string;
    private _reqSeq = 0;
    /** 记录已处理请求序号，保证幂等（重连补发不会重复落子）。 */
    private readonly _handled = new Set<number>();
    /** AI 是否正在思考（防止并发多次触发）。 */
    private _aiThinking = false;

    constructor(
        firstPlayerId: string,
        secondPlayerId: string,
        aiPlayerId: string,
        level: AiLevel,
    ) {
        this._rules = new GomokuRules(firstPlayerId, secondPlayerId);
        this._opponentId = aiPlayerId === firstPlayerId ? secondPlayerId : firstPlayerId;
        this._aiPlayerId = aiPlayerId;
        this._ai = aiPlayerId ? new GomokuAi(aiPlayerId, firstPlayerId, level) : null;
    }

    public get rules(): GomokuRules {
        return this._rules;
    }

    /**
     * 处理上行请求（落子）。
     *
     * 上行：{ cmd: gk.move, payload: { row, col, reqSeq } }
     * 下行：{ cmd: gk.move.result, payload: GkMoveResultPayload }
     */
    public handleUpstream(msg: NetMessage): NetMessage[] {
        if (msg.cmd !== Cmd.GK_MOVE) {
            return [];
        }
        const p = msg.payload as { row: number; col: number; reqSeq: number };

        // 幂等去重
        if (this._handled.has(p.reqSeq)) {
            console.warn(`[GomokuAuthority] 重复请求 reqSeq=${p.reqSeq}，已忽略`);
            return [];
        }
        this._handled.add(p.reqSeq);

        const err = this._rules.validateMove(p.row, p.col, msg.playerId);
        if (err !== null) {
            return [this._err(msg.roomId, msg.playerId, Cmd.GK_MOVE, err)];
        }

        const applied = this._rules.applyMove(p.row, p.col, msg.playerId);
        if (!applied) {
            return [this._err(msg.roomId, msg.playerId, Cmd.GK_MOVE, '落子失败')];
        }

        const out: NetMessage[] = [this._moveResult(msg.roomId, p.row, p.col, msg.playerId)];

        if (this._rules.finished) {
            out.push(this._gameOver(msg.roomId));
        }
        return out;
    }

    /**
     * AI 行动：仅当轮到我方对手（AI）且未结束时产生一条下行消息。
     * 这条消息与真人落子的下行消息结构一模一样。
     */
    public pollAiAction(): NetMessage[] {
        if (!this._ai || this._rules.finished || this._aiThinking) {
            return [];
        }
        if (this._rules.currentPlayerId !== this._aiPlayerId) {
            return [];
        }

        const decision = this._ai.decide(this._rules);
        if (!decision) {
            return [];
        }

        // 模拟思考延迟：标记思考中，延迟后再落子（由轮询在后续 tick 取出）
        this._aiThinking = true;
        const delay = GomokuAi.thinkDelayMs();
        setTimeout(() => {
            this._aiThinking = false;
        }, delay);

        if (!this._rules.applyMove(decision.row, decision.col, this._aiPlayerId)) {
            return [];
        }

        const roomId = this._roomId;
        const out: NetMessage[] = [
            this._moveResult(roomId, decision.row, decision.col, this._aiPlayerId),
        ];
        if (this._rules.finished) {
            out.push(this._gameOver(roomId));
        }
        return out;
    }

    public onConnect(): NetMessage[] {
        return [];
    }

    public onResync(): NetMessage[] {
        // 重连补偿：把已落子的完整历史重放给客户端
        const roomId = this._roomId;
        return this._rules.history.map((m) =>
            this._mk(roomId, this._aiPlayerId, Cmd.GK_MOVE_RESULT, {
                row: m.row,
                col: m.col,
                stone: m.stone,
                playerId: m.playerId,
                win: false,
                winLine: [],
                draw: false,
                nextPlayerId: m.playerId,
            } as GkMoveResultPayload),
        );
    }

    private _roomId = '';

    /** 由外部注入 roomId（消息构造需要）。 */
    public setRoomId(id: string): void {
        this._roomId = id;
    }

    private _moveResult(
        roomId: string,
        row: number,
        col: number,
        playerId: string,
    ): NetMessage {
        const win = this._rules.finished && !this._rules.isDraw;
        const payload: GkMoveResultPayload = {
            row,
            col,
            stone: this._rules.stoneOf(playerId) as 1 | 2,
            playerId,
            win,
            winLine: win ? this._rules.winLine : [],
            draw: this._rules.isDraw,
            nextPlayerId: this._rules.currentPlayerId,
        };
        return this._mk(roomId, playerId, Cmd.GK_MOVE_RESULT, payload);
    }

    private _gameOver(roomId: string): NetMessage {
        const stats = this._rules.history.length;
        void stats;
        return this._mk(roomId, this._aiPlayerId, Cmd.GAME_OVER, {
            winnerId: this._rules.winnerId,
            draw: this._rules.isDraw,
            reason: this._rules.isDraw ? 'draw' : 'win',
            stats: [],
        });
    }

    private _err(roomId: string, playerId: string, cmd: string, message: string): NetMessage {
        return this._mk(roomId, playerId, Cmd.SYS_ERROR, { code: 4000, message, cmd });
    }

    private _mk(roomId: string, playerId: string, cmd: string, payload: unknown): NetMessage {
        return {
            cmd,
            roomId,
            playerId,
            payload,
            timestamp: Date.now(),
        };
    }
}

/**
 * 五子棋 IGame 实现。
 */
export class GomokuGame implements IGame {
    public readonly gameId = GameId.GOMOKU;

    private readonly _ctx: GameContext;
    private _board: GomokuBoard | null = null;
    private _rules: GomokuRules | null = null;
    private _authority: GomokuAuthority | null = null;
    private _unsub: (() => void) | null = null;
    private _reqSeq = 0;
    private _finished = false;
    private _result: GameResult | null = null;
    private _startTime = 0;

    constructor(ctx: GameContext) {
        this._ctx = ctx;
    }

    // ==================== IGame 生命周期 ====================

    public init(ctx: GameContext): void {
        this._ctx.mode = ctx.mode;
    }

    /** 注入视图（由 GameScene 创建后调用）。 */
    public attachView(board: GomokuBoard): void {
        this._board = board;
    }

    public onEnter(): void {
        this._startTime = Date.now();
        const { room, myPlayerId, opponent, seed, firstPlayerId } = this._ctx;

        // 本地规则实例：仅用于「渲染与本地校验」，权威判定由服务端/权威裁判负责
        const first = firstPlayerId || room.seats[0].playerId;
        const second = first === myPlayerId ? opponent.playerId : myPlayerId;
        this._rules = new GomokuRules(first, second);

        // 渲染初始棋盘
        if (this._board) {
            this._board.setup(this._rules, myPlayerId);
            this._board.renderAll();
            this._board.setInputEnabled(!this._rules.finished);
        }

        // 联机/AI 模式下，均通过同步通道收发
        const net = this._getNetSync();
        if (net) {
            this._unsub = net.onMessage((m) => this.onSyncMessage(m));
            // 建立连接（AI 模式下 MockNetSync 会绑定 AI 权威）
            void net.connect(room.roomId);
        }

        console.log(
            `[GomokuGame] 进入对局 mode=${this._ctx.mode} seed=${seed} 先手=${first} ` +
                `我方=${myPlayerId} 对手=${opponent.playerId}`,
        );
    }

    public onSyncMessage(msg: NetMessage): void {
        switch (msg.cmd) {
            case Cmd.GK_MOVE_RESULT: {
                const p = msg.payload as GkMoveResultPayload;
                this._applyMoveResult(p);
                break;
            }
            case Cmd.GAME_OVER: {
                const p = msg.payload as {
                    winnerId: string;
                    draw: boolean;
                    reason: GameResult['reason'];
                };
                this._finishGame(p.winnerId, p.draw, p.reason);
                break;
            }
            case Cmd.GAME_RESYNC: {
                // 全量状态补偿：逐条重放（幂等：已有棋子的位置会被跳过）
                break;
            }
            default:
                break;
        }
    }

    public onAiTurn(): void {
        // 联机模式下不会调用；AI 模式由权威裁判内部驱动，此处仅用于 UI 提示
        if (this._board) {
            this._board.showThinking(true);
        }
    }

    public onExit(): void {
        if (this._unsub) {
            this._unsub();
            this._unsub = null;
        }
        this._getNetSync()?.disconnect();
        this._board = null;
        console.log('[GomokuGame] 退出对局');
    }

    public getResult(): GameResult | null {
        return this._result;
    }

    public isFinished(): boolean {
        return this._finished;
    }

    public isMyTurn(): boolean {
        if (!this._rules || this._finished) {
            return false;
        }
        return this._rules.currentPlayerId === this._ctx.myPlayerId;
    }

    // ==================== 玩家操作 ====================

    /**
     * 玩家点击棋盘（由 GomokuBoard 回调）。
     *
     * 双模式统一走协议：不直接改本地棋盘，而是发送上行请求，
     * 等下行权威结果再更新 UI（与真实服务器模型一致，天然防作弊）。
     */
    public onPlayerClick(row: number, col: number): void {
        if (this._finished || !this._rules) {
            return;
        }
        if (!this.isMyTurn()) {
            console.log('[GomokuGame] 未轮到本方，忽略点击');
            return;
        }
        const err = this._rules.validateMove(row, col, this._ctx.myPlayerId);
        if (err !== null) {
            return;
        }

        const net = this._getNetSync();
        if (!net) {
            console.warn('[GomokuGame] 无同步通道，无法落子');
            return;
        }

        this._reqSeq++;
        net.send(Cmd.GK_MOVE, { row, col, reqSeq: this._reqSeq });
        if (this._board) {
            this._board.showThinking(true);
        }
    }

    public surrender(): void {
        if (this._finished) {
            return;
        }
        const net = this._getNetSync();
        net?.send(Cmd.GAME_SURRENDER, { playerId: this._ctx.myPlayerId });
        // 本地立即结算（权威方也会广播；幂等处理）
        this._finishGame(this._ctx.opponent.playerId, false, 'surrender');
    }

    /** 发送表情（对局内快捷互动）。 */
    public sendEmote(emoteId: number): void {
        this._getNetSync()?.send(Cmd.GAME_EMOTE, { emoteId });
    }

    // ==================== 内部实现 ====================

    private _applyMoveResult(p: GkMoveResultPayload): void {
        if (!this._rules) {
            return;
        }
        // 幂等：已存在棋子的位置跳过（重连补发场景）
        if (this._rules.get(p.row, p.col) !== 0) {
            return;
        }
        this._rules.applyMove(p.row, p.col, p.playerId);

        if (this._board) {
            this._board.showThinking(false);
            this._board.placeStone(p.row, p.col, p.stone as Stone, p.winLine);
            this._board.setInputEnabled(
                !this._rules.finished && this._rules.currentPlayerId === this._ctx.myPlayerId,
            );
        }

        if (p.win || p.draw) {
            const winner = p.win ? p.playerId : '';
            this._finishGame(winner, p.draw, p.draw ? 'draw' : 'win');
        }
    }

    private _finishGame(winnerId: string, draw: boolean, reason: GameResult['reason']): void {
        if (this._finished) {
            return;
        }
        this._finished = true;

        const oppId = this._ctx.opponent.playerId;
        const myId = this._ctx.myPlayerId;
        const scoreOf = (id: string): number => {
            if (id === myId) {
                return winnerId === myId ? 1 : draw ? 0 : 0;
            }
            return winnerId === oppId ? 1 : 0;
        };

        this._result = {
            gameId: this.gameId,
            winnerId,
            draw,
            reason,
            stats: [
                {
                    playerId: myId,
                    nickname: this._nickOf(myId),
                    score: draw ? 0 : winnerId === myId ? 1 : 0,
                    moves: this._rules ? Math.ceil(this._rules.moveCount / 2) : 0,
                },
                {
                    playerId: oppId,
                    nickname: this._nickOf(oppId),
                    score: draw ? 0 : winnerId === oppId ? 1 : 0,
                    moves: this._rules ? Math.floor(this._rules.moveCount / 2) : 0,
                },
            ],
            durationMs: Date.now() - this._startTime,
        };
        void scoreOf;

        if (this._board) {
            this._board.setInputEnabled(false);
        }
        console.log(
            `[GomokuGame] 对局结束 winner=${winnerId || '(平局)'} reason=${reason} ` +
                `用时=${(this._result.durationMs / 1000).toFixed(1)}s`,
        );
    }

    private _nickOf(playerId: string): string {
        const seat = this._ctx.room.seats.find((s) => s.playerId === playerId);
        return seat ? seat.nickname : playerId;
    }

    private _getNetSync(): INetSyncService | null {
        try {
            return services.netSync;
        } catch (err) {
            console.error('[GomokuGame] 获取同步服务失败:', err);
            return null;
        }
    }

    /** 供 GameScene 装配 Mock 权威（AI 模式）。 */
    public setAuthority(auth: GomokuAuthority): void {
        this._authority = auth;
    }

    public get authority(): GomokuAuthority | null {
        return this._authority;
    }

    /** 兼容：供 MockNetSyncService 绑定。 */
    public get mode(): GameMode {
        return this._ctx.mode;
    }
}
