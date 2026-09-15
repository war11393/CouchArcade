/**
 * IGame —— 所有游戏的统一接口（双模式无缝切换的关键抽象）。
 *
 * 设计原则（规格「双模式共用同一套游戏规则逻辑与 UI 表现层，仅数据源不同」）：
 * - 规则逻辑（纯 TS，可单元测试）与表现层（Cocos 组件）分离；
 * - 联机模式：操作经 INetSyncService 上行，棋局变更只认下行权威消息；
 * - AI 练习模式：本地直接调用同一套规则逻辑 + AI，但**仍然走协议消息**
 *   （由 MockNetSync 的权威裁判统一处理），从而复用完全相同的 UI 更新路径。
 *
 * 这样一个游戏只需要写一份「收到 XXX 消息 → 更新棋盘」的代码，
 * 两种模式共用，新增游戏成本极低。
 */

import { AiLevel } from '../../config/AppConfig';
import { GameId } from '../../config/GameList';
import { NetMessage, RoomState, SeatInfo } from '../../core/services/IServices';

/** 对局模式。 */
export type GameMode = 'pvp' | 'ai';

/** 对局结果。 */
export interface GameResult {
    gameId: GameId;
    /** 胜者 playerId；平局为空字符串 */
    winnerId: string;
    /** 是否平局 */
    draw: boolean;
    /** 结束原因 */
    reason: 'win' | 'draw' | 'surrender' | 'timeout' | 'offline' | 'leave';
    /** 双方数据 */
    stats: Array<{ playerId: string; nickname: string; score: number; moves: number }>;
    /** 对局时长（毫秒） */
    durationMs: number;
}

/** 游戏初始化上下文：由 GameScene 在对局开始时注入。 */
export interface GameContext {
    mode: GameMode;
    /** 房间快照（含座位、昵称、头像、AI 难度） */
    room: RoomState;
    /** 本机 playerId */
    myPlayerId: string;
    /** 对手座位（1v1 场景；多人游戏取 seats 自行处理） */
    opponent: SeatInfo;
    /** 随机种子（布局/一切随机行为基于它，保证双端一致） */
    seed: number;
    /** 先手玩家 playerId */
    firstPlayerId: string;
}

/**
 * 游戏模块统一接口。
 *
 * 生命周期：init → onEnter → （onSyncMessage / onAiTurn 循环）→ onExit
 */
export interface IGame {
    /** 游戏标识。 */
    readonly gameId: GameId;

    /** 初始化：注入模式与房间上下文（此时 UI 已就绪，可渲染空棋盘）。 */
    init(ctx: GameContext): void;

    /** 进入对局：开始监听同步消息、启动计时、渲染初始棋盘。 */
    onEnter(): void;

    /**
     * 收到同步协议消息。
     *
     * 联机模式：来自真实服务器下行；
     * AI 模式：同样来自 MockNetSync 的协议通道（对手由 AI 驱动）——
     *         这就是「Mock 联机 = 通过同步协议通道与 AI 对打」的落点。
     *
     * 实现要求：只据此更新本地棋盘与状态，绝不在此处直接改规则数据。
     */
    onSyncMessage(msg: NetMessage): void;

    /**
     * AI 回合回调（仅用于本地 UI 提示「对手思考中」）。
     *
     * 注意：真正的 AI 决策在权威层（AI 练习模式下由本地权威驱动）。
     * 联机模式下本方法不会被调用。
     */
    onAiTurn?(): void;

    /** 退出对局：清理监听、计时器、权威裁判引用。 */
    onExit(): void;

    /** 获取对局结果（结算页使用）；未结束返回 null。 */
    getResult(): GameResult | null;

    /** 当前是否已结束。 */
    isFinished(): boolean;

    /** 玩家投降（由 UI 投降按钮调用）。 */
    surrender(): void;

    /** 当前是否轮到本机行动（UI 据此启用/禁用操作）。 */
    isMyTurn(): boolean;
}

/**
 * 布局提供方抽象（寻机头专用，但设计上通用）。
 *
 * 第一阶段：联机/Mock 模式由本地规则层担任权威（经 MockSync 下发翻格结果）；
 * 第二阶段：切换为云函数生成 + 加密存储（客户端始终只按格查询结果，杜绝篡改）。
 */
export interface ILayoutProvider {
    /**
     * 生成权威布局。仅服务端权威方调用。
     * @param seed 随机种子
     */
    generate(seed: number): unknown;

    /**
     * 查询单格内容（客户端只能这样获取信息，无法拿到整个布局）。
     *
     * @returns 该格内容编码；具体语义由各游戏定义
     */
    queryCell(layout: unknown, row: number, col: number): number;

    /** 布局序列化（用于写入云数据库；服务端加密存储）。 */
    serialize(layout: unknown): string;

    /** 布局反序列化（服务端读取时使用）。 */
    deserialize(raw: string): unknown;
}

/** AI 决策接口（各游戏实现自己的评分逻辑）。 */
export interface IGameAi<TAction, TState> {
    /**
     * 计算下一步操作。
     * @param state 当前棋局状态（只读）
     * @param aiPlayerId AI 自身 playerId（用于区分敌我）
     * @param level 难度
     * @returns 操作描述；无合法操作返回 null
     */
    decide(state: TState, aiPlayerId: string, level: AiLevel): TAction | null;

    /** 模拟思考延迟（毫秒），用于让 AI 出手节奏自然。 */
    thinkDelay(level: AiLevel): number;
}
