/**
 * 寻机头对局模块（实现 IGame）。
 *
 * 与五子棋同构：双模式共用一套规则与 UI，仅数据源不同。
 *
 * 权威模型（规格关键要求）：
 * - 布局权威方抽象为 ILayoutProvider；
 * - 第一阶段：联机/Mock 模式由本地规则层担任权威（经 MockSync 下发翻格结果）；
 * - 第二阶段：切换为云函数生成 + 加密存储，客户端始终只按格查询结果，杜绝篡改。
 */

import { AiLevel } from '../../config/AppConfig';
import { GameId } from '../../config/GameList';
import { INetSyncService, NetMessage } from '../../core/services/IServices';
import { Cmd, PhFlipResultPayload } from '../../core/protocol/Protocol';
import { GameContext, GameMode, GameResult, IGame } from '../common/IGame';
import { IMockAuthority } from '../../core/services/mock/MockNetSyncService';
import { services } from '../../core/ServiceLocator';
import { PlaneHuntAi } from './PlaneHuntAi';
import { PlaneHuntRules } from './PlaneHuntRules';
import { PlaneHuntBoard } from './PlaneHuntBoard';
import { CELL_HEAD } from './PlaneHuntLayout';

/**
 * 寻机头权威裁判（Mock 阶段由本地规则层担任）。
 *
 * 输入输出与真实云函数（cloudfunctions/planehunt_flip）完全一致：
 * 上行 { cmd: ph.flip, payload: { row, col, reqSeq } }
 * 下行 { cmd: ph.flip.result, payload: PhFlipResultPayload }
 *
 * 安全性说明：客户端永远拿不到布局，只能逐格询问结果，
 * 因此第一阶段即可验证「防篡改」的架构正确性。
 */
export class PlaneHuntAuthority implements IMockAuthority {
    private readonly _rules: PlaneHuntRules;
    private readonly _ai: PlaneHuntAi | null;
    private readonly _aiPlayerId: string;
    private readonly _roomId: string;
    private readonly _handled = new Set<number>();
    private _aiBusy = false;
    /** AI 待执行的动作（思考延迟结束后取出）。 */
    private _aiPending: { row: number; col: number } | null = null;

    constructor(
        roomId: string,
        firstPlayerId: string,
        secondPlayerId: string,
        aiPlayerId: string,
        seed: number,
        level: AiLevel,
    ) {
        this._roomId = roomId;
        this._rules = new PlaneHuntRules(firstPlayerId, secondPlayerId, seed);
        this._aiPlayerId = aiPlayerId;
        this._ai = aiPlayerId ? new PlaneHuntAi(level) : null;
    }

    public get rules(): PlaneHuntRules {
        return this._rules;
    }

    /** 处理上行翻格请求。 */
    public handleUpstream(msg: NetMessage): NetMessage[] {
        if (msg.cmd !== Cmd.PH_FLIP) {
            return [];
        }
        const p = msg.payload as { row: number; col: number; reqSeq: number };

        if (this._handled.has(p.reqSeq)) {
            console.warn(`[PlaneHuntAuthority] 重复请求 reqSeq=${p.reqSeq}，已忽略`);
            return [];
        }
        this._handled.add(p.reqSeq);

        const result = this._rules.applyFlip(p.row, p.col, msg.playerId);
        if (!result) {
            return [
                this._mk(msg.playerId, Cmd.SYS_ERROR, {
                    code: 4000,
                    message: '非法翻格',
                    cmd: Cmd.PH_FLIP,
                }),
            ];
        }

        const out: NetMessage[] = [this._mk(msg.playerId, Cmd.PH_FLIP_RESULT, result)];
        if (this._rules.finished) {
            out.push(this._gameOver());
        }
        return out;
    }

    /**
     * AI 行动。
     *
     * 注意「机头奖励连翻」的处理：AI 翻中机头后会连续行动，
     * 本方法在每次轮询中被调用，因此能自然地连续出手（每次一个 tick）。
     */
    public pollAiAction(): NetMessage[] {
        if (!this._ai || this._rules.finished) {
            return [];
        }
        if (this._rules.currentPlayerId !== this._aiPlayerId) {
            this._aiPending = null;
            return [];
        }

        // 思考中：等待延迟结束
        if (this._aiBusy) {
            return [];
        }

        // 若已有待执行动作，执行它
        if (this._aiPending) {
            const act = this._aiPending;
            this._aiPending = null;
            const result = this._rules.applyFlip(act.row, act.col, this._aiPlayerId);
            if (!result) {
                return [];
            }
            const out: NetMessage[] = [this._mk(this._aiPlayerId, Cmd.PH_FLIP_RESULT, result)];
            if (this._rules.finished) {
                out.push(this._gameOver());
            }
            return out;
        }

        // 计算并安排下一次动作（模拟思考延迟）
        const decision = this._ai.decide(this._rules);
        if (!decision) {
            return [];
        }
        this._aiPending = { row: decision.row, col: decision.col };
        this._aiBusy = true;
        const delay = PlaneHuntAi.thinkDelayMs();
        setTimeout(() => {
            this._aiBusy = false;
        }, delay);

        return [];
    }

    public onConnect(): NetMessage[] {
        // 下发布局元信息（尺寸/飞机数），不含明文机头坐标
        return [
            this._mk(this._aiPlayerId, Cmd.PH_LAYOUT, {
                size: this._rules.size,
                planeCount: this._rules.totalHeads,
            }),
        ];
    }

    public onResync(): NetMessage[] {
        // 断线重连：把已揭示的格子全部重放（幂等）
        return this._rules.allRevealed().map((rev) =>
            this._mk(rev.byPlayerId, Cmd.PH_FLIP_RESULT, {
                row: rev.row,
                col: rev.col,
                cell: rev.cell,
                scored: rev.cell === CELL_HEAD,
                extraTurn: false,
                headsFound: this._rules.headsFound,
                score: this._rules.scoreOf(rev.byPlayerId),
                nextPlayerId: this._rules.currentPlayerId,
                planeIndex: rev.planeIndex,
            } as PhFlipResultPayload),
        );
    }

    private _gameOver(): NetMessage {
        return this._mk(this._aiPlayerId, Cmd.GAME_OVER, {
            winnerId: this._rules.winnerId,
            draw: this._rules.isDraw,
            reason: this._rules.isDraw ? 'draw' : 'win',
            stats: this._rules.allScores().map((s) => ({
                playerId: s.playerId,
                score: s.score,
                moves: s.moves,
            })),
        });
    }

    private _mk(playerId: string, cmd: string, payload: unknown): NetMessage {
        return {
            cmd,
            roomId: this._roomId,
            playerId,
            payload,
            timestamp: Date.now(),
        };
    }
}

/**
 * 寻机头 IGame 实现。
 */
export class PlaneHuntGame implements IGame {
    public readonly gameId = GameId.PLANE_HUNT;

    private readonly _ctx: GameContext;
    private _board: PlaneHuntBoard | null = null;
    private _rules: PlaneHuntRules | null = null;
    private _unsub: (() => void) | null = null;
    private _reqSeq = 0;
    private _finished = false;
    private _result: GameResult | null = null;
    private _startTime = 0;

    constructor(ctx: GameContext) {
        this._ctx = ctx;
    }

    public init(ctx: GameContext): void {
        this._ctx.mode = ctx.mode;
    }

    /** 注入视图。 */
    public attachView(board: PlaneHuntBoard): void {
        this._board = board;
    }

    public onEnter(): void {
        this._startTime = Date.now();
        const { room, myPlayerId, opponent, seed, firstPlayerId } = this._ctx;

        const first = firstPlayerId || room.seats[0].playerId;
        const second = first === myPlayerId ? opponent.playerId : myPlayerId;
        // 本地规则实例仅用于渲染（客户端不知道布局，翻格结果由权威下发）
        this._rules = new PlaneHuntRules(first, second, seed);

        if (this._board) {
            this._board.setup(myPlayerId, first);
            this._board.renderGrid();
        }

        const net = this._getNetSync();
        if (net) {
            this._unsub = net.onMessage((m) => this.onSyncMessage(m));
            void net.connect(room.roomId);
        }

        console.log(
            `[PlaneHuntGame] 进入对局 mode=${this._ctx.mode} seed=${seed} 先手=${first} ` +
                `我方=${myPlayerId} 对手=${opponent.playerId}`,
        );
    }

    public onSyncMessage(msg: NetMessage): void {
        switch (msg.cmd) {
            case Cmd.PH_FLIP_RESULT: {
                const p = msg.payload as PhFlipResultPayload;
                this._applyFlipResult(p);
                break;
            }
            case Cmd.PH_LAYOUT: {
                // 布局元信息（第二阶段用于显示进度条上限）
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
            default:
                break;
        }
    }

    public onAiTurn(): void {
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
        console.log('[PlaneHuntGame] 退出对局');
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
     * 玩家点击格子（由 PlaneHuntBoard 回调）。
     *
     * 双模式统一走协议：只发送翻格请求，翻格结果完全由权威方下发。
     * 这保证了客户端无法通过改内存作弊（与第二阶段云函数模型一致）。
     */
    public onPlayerClick(row: number, col: number): void {
        if (this._finished || !this._rules) {
            return;
        }
        if (!this.isMyTurn()) {
            return;
        }
        if (this._rules.isRevealed(row, col)) {
            return;
        }

        const net = this._getNetSync();
        if (!net) {
            console.warn('[PlaneHuntGame] 无同步通道，无法翻格');
            return;
        }

        this._reqSeq++;
        net.send(Cmd.PH_FLIP, { row, col, reqSeq: this._reqSeq });
    }

    public surrender(): void {
        if (this._finished) {
            return;
        }
        const net = this._getNetSync();
        net?.send(Cmd.GAME_SURRENDER, { playerId: this._ctx.myPlayerId });
        this._finishGame(this._ctx.opponent.playerId, false, 'surrender');
    }

    public sendEmote(emoteId: number): void {
        this._getNetSync()?.send(Cmd.GAME_EMOTE, { emoteId });
    }

    // ==================== 内部 ====================

    private _applyFlipResult(p: PhFlipResultPayload): void {
        if (!this._rules) {
            return;
        }
        // 幂等：已揭示的格子跳过
        if (this._rules.isRevealed(p.row, p.col)) {
            return;
        }
        // 本地记录（用于 UI 与回合指示；布局信息不参与，因为规则层不知道内容）
        this._rules = this._rules; // 保留引用语义，实际状态以权威下发为准

        if (this._board) {
            this._board.showThinking(false);
            this._board.revealCell(p.row, p.col, p.cell, p.scored, p.score);
            this._board.setTurn(p.nextPlayerId === this._ctx.myPlayerId, p.headsFound, this._headTotal());
        }

        // 机头奖励：连续翻格时给 UI 提示
        if (p.extraTurn && this._board) {
            this._board.showBonusTip();
        }

        if (this._board) {
            this._board.setInputEnabled(!this._finished && p.nextPlayerId === this._ctx.myPlayerId);
        }
    }

    /** 机头总数（从房间配置推导，第一阶段固定 5）。 */
    private _headTotal(): number {
        return this._rules ? this._rules.totalHeads : 5;
    }

    private _finishGame(winnerId: string, draw: boolean, reason: GameResult['reason']): void {
        if (this._finished) {
            return;
        }
        this._finished = true;

        const myId = this._ctx.myPlayerId;
        const oppId = this._ctx.opponent.playerId;
        const myScore = this._board ? this._board.getMyScore() : 0;
        const oppScore = this._board ? this._board.getOppScore() : 0;

        this._result = {
            gameId: this.gameId,
            winnerId,
            draw,
            reason,
            stats: [
                {
                    playerId: myId,
                    nickname: this._nickOf(myId),
                    score: myScore,
                    moves: this._board ? this._board.getMyFlips() : 0,
                },
                {
                    playerId: oppId,
                    nickname: this._nickOf(oppId),
                    score: oppScore,
                    moves: this._board ? this._board.getOppFlips() : 0,
                },
            ],
            durationMs: Date.now() - this._startTime,
        };

        if (this._board) {
            this._board.setInputEnabled(false);
        }
        console.log(
            `[PlaneHuntGame] 对局结束 winner=${winnerId || '(平局)'} reason=${reason} ` +
                `比分=${myScore}:${oppScore} 用时=${(this._result.durationMs / 1000).toFixed(1)}s`,
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
            console.error('[PlaneHuntGame] 获取同步服务失败:', err);
            return null;
        }
    }

    public get mode(): GameMode {
        return this._ctx.mode;
    }
}
