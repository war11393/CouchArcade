/**
 * Game 场景控制器（对局界面）。
 *
 * 规格要求：
 * - 动态加载对应游戏 Prefab；
 * - 含双方信息、回合指示、计时、表情快捷互动、投降、结算弹窗；
 * - 竖屏布局：上方对手信息、中部棋盘自适应、下方己方信息与操作区。
 *
 * 双模式：pvp / ai 共用本场景，仅上下文不同。
 */

import { _decorator, Component, Label, Layers, Node, UITransform } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { GameId } from '../config/GameList';
import { RoomState, SeatInfo } from '../core/services/IServices';
import { services, ensureServices } from '../core/ServiceLocator';
import { EMOTES } from '../core/protocol/Protocol';
import { uiManager } from '../core/UIManager';
import {
    THEME,
    bindClick,
    displayName,
    displayNumber,
    findNode,
    forceUILayer,
    labelAt,
    setLabelText,
} from '../core/UIFactory';
import { GameContext, GameResult, IGame } from '../games/common/IGame';
import { portraitAdapter } from '../core/PortraitAdapter';
import { createGame } from '../games/common/GameRegistry';
import { GomokuBoard } from '../games/gomoku/GomokuBoard';
import { GomokuGame, GomokuAuthority } from '../games/gomoku/GomokuGame';
import { PlaneHuntBoard } from '../games/planehunt/PlaneHuntBoard';
import { PlaneHuntAuthority, PlaneHuntGame } from '../games/planehunt/PlaneHuntGame';
import { saveMatchRecord } from '../stats/StatsService';

const { ccclass } = _decorator;

@ccclass('GameScene')
export class GameScene extends Component {
    private _game: IGame | null = null;
    private _ctx: GameContext | null = null;
    private _boardNode: Node | null = null;
    private _timerHandle: ReturnType<typeof setInterval> | null = null;
    /** 剩余秒数。 */
    private _remainSec = AppConfig.TURN_TIME_LIMIT_SEC;
    private _turnSeq = 0;
    private _savedRecord = false;

    /** HUD 引用。 */
    //
    // 注意：回合指示只有**一个** Label（TurnLabel）。曾经有 _myTurnLabel 与
    // _oppTurnLabel 两个字段都指向同一个节点，导致两条分支互相覆盖 —— 那是
    // 「看不出当前是谁的回合」的直接原因。现在改为「一个回合文案 + 两个高亮点」。
    private _turnLabel: Label | null = null;
    /** 对手 / 我 的回合高亮圆点（◆，仅当前回合方显示）。 */
    private _oppTurnMark: Label | null = null;
    private _myTurnMark: Label | null = null;
    /** 寻机头专用：已找到的机头数文案。 */
    private _headsLabel: Label | null = null;
    private _timerLabel: Label | null = null;
    private _oppScoreLabel: Label | null = null;
    private _myScoreLabel: Label | null = null;
    private _oppNameLabel: Label | null = null;
    private _myNameLabel: Label | null = null;
    private _emotePanel: Node | null = null;

    protected async onLoad(): Promise<void> {
        ensureServices();
        // 竖版自适应：按机型重算设计分辨率 + 贴边条安全区避让（见 core/PortraitAdapter.ts）
        // 必须早于 _createGame —— 棋盘的可用宽高从重算后的视口来取。
        portraitAdapter.apply();
        portraitAdapter.applyEdgeInsets(this.node);
        // ⚠️ consumeGameParams 现在是 async（参数可以是「建房」的异步函数，见 UIManager.gotoGame）：
        //    AI 练习从大厅点进来时，房间要在**本场景 onLoad 内**才建好 ——
        //    这样既不必闪一下房间页，也不必让玩家在大厅干等一次云函数往返。
        const params = await uiManager.consumeGameParams();
        if (!params) {
            console.warn('[GameScene] 缺少对局参数，返回大厅');
            uiManager.gotoLobby();
            return;
        }

        const user = services.auth.getCachedUser();
        const myPlayerId = user ? user.openid : '';
        const room: RoomState = params.room;

        // 找出自己与对手座位
        const mySeat = room.seats.find((s) => s.playerId === myPlayerId);
        const oppSeat = room.seats.find((s) => s.playerId !== myPlayerId && s.playerId !== '');
        if (!mySeat || !oppSeat) {
            // 报错必须带**双方视角的细节**：「座位异常」的常见原因是客户端身份
            // （登录降级产生的 local_* 会话）与服务端座位里的真 openid 对不上 ——
            // 不打出 playerId 与座位清单，只看这一行日志根本无从下判断。
            console.error(
                '[GameScene] 座位信息异常，返回大厅 —— 我方id=' +
                    (myPlayerId || '(空！auth.getCachedUser 为 null)') +
                    ' 座位=[' +
                    room.seats
                        .map((s) => `${s.nickname || '(空)'}:${s.playerId || '(空位)'}`)
                        .join(' | ') +
                    ']',
            );
            uiManager.gotoLobby();
            return;
        }

        this._ctx = {
            mode: params.mode,
            room,
            myPlayerId,
            opponent: oppSeat,
            seed: room.seed,
            firstPlayerId: room.seats[0].playerId,
        };

        this._bindUI(mySeat, oppSeat);
        this._createGame(params.gameId);
    }

    protected onDestroy(): void {
        this._stopTimer();
        if (this._game) {
            this._game.onExit();
            this._game = null;
        }
        services.room.leaveRoom().catch((e) => console.error('[GameScene] 退房失败:', e));
    }

    /**
     * 构建对局 UI（竖屏三段式布局）。
     *
     * 节点结构（安全区锚点标注）：
     *   Game (Scene)
     *     └─ Canvas
     *          ├─ Bg (全屏)
     *          └─ SafeRoot (SafeAreaAdapter)
     *               ├─ OppBar  (安全区 top 下方：对手头像/昵称/得分/回合指示)
     *               ├─ TimerBar (顶部中央：本回合倒计时)
     *               ├─ BoardArea (中部：棋盘自适应撑满可用宽高)
     *               │    └─ (动态挂载 GomokuBoard / PlaneHuntBoard)
     *               ├─ MyBar   (棋盘下方：己方头像/昵称/得分)
     *               └─ ActionBar (安全区 bottom 上方：表情 / 投降)
     */
    /**
     * 绑定静态场景节点（不再运行时创建 UI）。
     *
     * 节点结构见 tools/ui-trees.js 的 gameTree()，可在编辑器层级管理器中看到：
     *   Canvas
     *     ├─ Bg                   [cc.Graphics]
     *     ├─ Hud                  [cc.Graphics]
     *     │   ├─ OppName / OppScore        [cc.Label]
     *     │   ├─ MyName / MyScore          [cc.Label]
     *     │   └─ TurnLabel / TimerLabel    [cc.Label]
     *     ├─ BoardArea            [cc.Graphics]   ← 棋盘动态挂载点
     *     │   └─ BoardHint        [cc.Label]
     *     ├─ EmotePanel           [cc.Graphics]   （默认隐藏）
     *     │   └─ EmoteList        [cc.Label]
     *     ├─ ActionBar            [cc.Graphics]
     *     │   ├─ BtnEmote / BtnUndo / BtnLeaveGame [cc.Button]
     *     ├─ SceneRoot            [GameScene]
     *     └─ Camera               [cc.Camera]
     */
    private _bindUI(mySeat: SeatInfo, oppSeat: SeatInfo): void {
        // ⚠️ 昵称必须兜底（2026-09-24 真机反馈「出现很多 undefined」）：
        //    座位信息来自云函数/实时推送，任何一端字段缺失都会把 undefined
        //    直接拼进 Label 变成 "undefined 🤖"，非常显眼。
        //    这里统一走 displayName() 清洗，宁可显示「对手」也不显示 undefined。
        const oppTag = oppSeat.isAI ? ' 🤖' : '';
        setLabelText(this.node, 'Canvas/Hud/OppName', `${displayName(oppSeat.nickname, '对手')}${oppTag}`);
        setLabelText(this.node, 'Canvas/Hud/OppScore', '0');
        setLabelText(this.node, 'Canvas/Hud/MyName', `${displayName(mySeat.nickname, '我')} (我)`);
        setLabelText(this.node, 'Canvas/Hud/MyScore', '0');
        setLabelText(this.node, 'Canvas/Hud/TurnLabel', '对局开始');
        setLabelText(this.node, 'Canvas/Hud/TimerLabel', `${AppConfig.TURN_TIME_LIMIT_SEC}s`);

        // ⚠️ 回合指示是**一个**节点，不是「我方/对手各一个」。
        //    早期实现把 _myTurnLabel 和 _oppTurnLabel 都指向 Hud/TurnLabel，
        //    两个分支每帧互相覆盖，导致回合文案闪烁/看起来「不显示当前回合」。
        //    现在只保留一个引用 + 两个「回合高亮圆点」（对手/我 各一个）。
        this._turnLabel = labelAt(this.node, 'Canvas/Hud/TurnLabel');
        this._oppTurnMark = labelAt(this.node, 'Canvas/Hud/OppTurnMark');
        this._myTurnMark = labelAt(this.node, 'Canvas/Hud/MyTurnMark');
        this._headsLabel = labelAt(this.node, 'Canvas/Hud/HeadsLabel');
        this._oppScoreLabel = labelAt(this.node, 'Canvas/Hud/OppScore');
        this._myScoreLabel = labelAt(this.node, 'Canvas/Hud/MyScore');
        this._timerLabel = labelAt(this.node, 'Canvas/Hud/TimerLabel');

        // 名字标签的默认色（回合高亮时改成主题色，恢复时用这两个值）
        this._oppNameLabel = labelAt(this.node, 'Canvas/Hud/OppName');
        this._myNameLabel = labelAt(this.node, 'Canvas/Hud/MyName');

        // 非寻机头对局：隐藏机头计数（置空格而不是隐藏节点，
        // 避免 validate-scenes 的「Label 非空」断言被破坏）
        if (this._ctx && this._ctx.room.gameId !== GameId.PLANE_HUNT) {
            setLabelText(this.node, 'Canvas/Hud/HeadsLabel', ' ');
        }

        // 棋盘挂载点（静态存在，棋盘内容由 BoardBase 动态绘制）
        const boardArea = findNode(this.node, 'Canvas/BoardArea');
        this._boardNode = boardArea;
        if (!boardArea) {
            console.error('[GameScene] 缺少 BoardArea 节点，棋盘无法挂载（检查 tools/ui-trees.js）');
        } else {
            // BoardHint 在棋盘挂载后隐藏
            const hint = findNode(this.node, 'Canvas/BoardArea/BoardHint');
            if (hint) hint.active = false;
        }

        // 表情面板（静态，默认隐藏）
        this._emotePanel = findNode(this.node, 'Canvas/EmotePanel');
        this._bindEmoteButtons();

        // 底部操作按钮
        bindClick(this.node, 'Canvas/ActionBar/BtnEmote', () => this._toggleEmotePanel());
        bindClick(this.node, 'Canvas/ActionBar/BtnRestart', () => this._onRestart());
        bindClick(this.node, 'Canvas/ActionBar/BtnLeaveGame', () => this._onSurrender());

        // ---- 短屏护栏（竖版自适应）----
        // 内容带 = Hud(248) 与 ActionBar(168) 之间的安全区竖带。
        // 基准机型（720×1280）放不下才动作（放得下零改动），iPad 竖屏
        // designH≈960 时：棋盘收缩 → GomokuBoard/PlaneHuntBoard 在
        // _createGame 里复制 BoardArea 的实际尺寸，cellSize 随高度收缩。
        // **必须在 _createGame 之前**执行，否则棋盘按旧尺寸绘制。
        if (this._boardNode) portraitAdapter.fitNodeInBand(this._boardNode, 248, 168);
        if (this._emotePanel) portraitAdapter.fitNodeInBand(this._emotePanel, 248, 168);
    }

    /** 给表情面板里的按钮绑定点击（静态场景里表情项是 EmoteList 文本，
     *  这里给面板整体绑一个「点一下换一个表情」的简易交互，保持原功能可用）。 */
    private _bindEmoteButtons(): void {
        const panel = this._emotePanel;
        if (!panel) return;
        // 面板内每个子节点（若有）都可点；当前场景里是单个 EmoteList 文本节点，
        // 因此给面板本身绑定轮换表情的交互。
        panel.on(Node.EventType.TOUCH_END, () => {
            const list = findNode(this.node, 'Canvas/EmotePanel/EmoteList');
            if (!list) return;
            const idx = (this._emoteIndex + 1) % EMOTES.length;
            this._emoteIndex = idx;
            this._sendEmote(idx);
        });
    }

    private _emoteIndex = 0;

    // ==================== 游戏创建 ====================

    /**
     * 动态创建游戏模块并挂载棋盘视图。
     *
     * 这是「动态加载对应游戏 Prefab」的第一阶段实现：
     * 用代码构建棋盘节点（零资源依赖），第二阶段可替换为
     * resources.load('prefabs/' + gameId) 加载音美术预制体。
     */
    private _createGame(gameId: GameId): void {
        const ctx = this._ctx!;
        const game = createGame(gameId, ctx);
        if (!game) {
            uiManager.toast('游戏未实现', undefined);
            uiManager.gotoLobby();
            return;
        }
        this._game = game;
        game.init(ctx);

        // 挂载棋盘视图
        if (gameId === GameId.GOMOKU) {
            const gomoku = game as GomokuGame;
            const boardNode = new Node('GomokuBoard');
            boardNode.layer = Layers.Enum.UI_2D;
            this._boardNode!.addChild(boardNode);
            boardNode.addComponent(UITransform).setContentSize(
                this._boardNode!.getComponent(UITransform)!.width,
                this._boardNode!.getComponent(UITransform)!.height,
            );
            const board = boardNode.addComponent(GomokuBoard);
            board.onCellClick = (r, c) => gomoku.onPlayerClick(r, c);
            gomoku.attachView(board);
            // 棋盘内部还有若干 new Node()（棋子/网格/落子标记），统一校正层级，
            // 否则这些节点是 DEFAULT 层 —— 相机看不见、点击也没有命中测试。
            forceUILayer(boardNode);

            // AI 练习模式：装配本地权威裁判
            if (ctx.mode === 'ai') {
                const auth = new GomokuAuthority(
                    ctx.firstPlayerId,
                    ctx.opponent.playerId,
                    ctx.opponent.playerId,
                    ctx.opponent.aiLevel,
                );
                auth.setRoomId(ctx.room.roomId);
                this._installAuthority(auth, ctx);
            }
            console.log('[GameScene] 五子棋模块与棋盘已创建');
        } else if (gameId === GameId.PLANE_HUNT) {
            const ph = game as PlaneHuntGame;
            const boardNode = new Node('PlaneHuntBoard');
            boardNode.layer = Layers.Enum.UI_2D;
            this._boardNode!.addChild(boardNode);
            boardNode.addComponent(UITransform).setContentSize(
                this._boardNode!.getComponent(UITransform)!.width,
                this._boardNode!.getComponent(UITransform)!.height,
            );
            const board = boardNode.addComponent(PlaneHuntBoard);
            board.onCellClick = (r, c) => ph.onPlayerClick(r, c);
            ph.attachView(board);
            // 同上：棋盘内部新建的节点也必须校正为 UI_2D 层
            forceUILayer(boardNode);

            if (ctx.mode === 'ai') {
                // ⚠️ 实参顺序必须对齐 PlaneHuntAuthority 的构造函数签名：
                //     (roomId, firstPlayerId, secondPlayerId, aiPlayerId, seed, level)
                // 曾经的写法把 ctx.myPlayerId 当 secondPlayerId 传了进去 ——
                // 当「我 = 先手」时两个座位都是我自己，opponentOf() 找不到对手，
                // 于是下发结果里 nextPlayerId 为空字符串，客户端 isMyTurn() 恒为 false，
                // 表现为「点了棋盘没有任何反应」（与五子棋 Authority 的签名不同，极易踩）。
                const oppId = ctx.opponent.playerId;
                const firstId = ctx.firstPlayerId || ctx.room.seats[0].playerId;
                const secondId = firstId === ctx.myPlayerId ? oppId : ctx.myPlayerId;
                const auth = new PlaneHuntAuthority(
                    ctx.room.roomId,
                    firstId,
                    secondId,
                    oppId,
                    ctx.seed,
                    ctx.opponent.aiLevel,
                );
                this._installAuthority(auth, ctx);
            }
            console.log('[GameScene] 寻机头模块与棋盘已创建');
        }

        // ⚠️ 告诉同步通道「本局是哪款游戏」—— 必须在 game.onEnter()（内部
        //    net.connect → _openWatch）之前完成。
        //
        // setGameId 决定 watch 的集合：gomoku → games_gomoku、
        // planehunt → games_planehunt；**未设置时回落到监听 rooms** ——
        // rooms 里只有房间状态、没有棋步，于是上行（云函数写库）一切正常，
        // 下行却永远等不到，真机表现为 WATCH_ACK_TIMEOUT「上行正常、下行断」。
        // 当时日志里其实已写明 `gameId=未指定 / 已监听 rooms`，而提示文案
        // 把人引向了集合权限 —— 这个教训也写进了看门狗注释。
        // （pvp 与 ai 共用本方法，两条路径同时被修复。）
        const netSync = services.netSync as unknown as { setGameId?: (g: GameId) => void };
        if (typeof netSync.setGameId === 'function') {
            netSync.setGameId(gameId);
            console.log(`[GameScene] netSync.setGameId(${gameId}) 完成（watch 将监听对应集合）`);
        } else {
            console.warn('[GameScene] netSync 无 setGameId —— watch 会监听到错误的集合');
        }

        // 统一生命周期：onEnter
        game.onEnter();
        this._startTimer();
        this._refreshHud();
    }

    /**
     * 装配 Mock 权威裁判到同步服务。
     *
     * 关键：AI 模式下，本地权威裁判接收上行请求、驱动 AI 决策，
     * 并把结果封装成与真实服务器一致的下行消息回传。
     * 这样「Mock 联机 = 通过同步协议通道与 AI 对打」得以成立。
     */
    private _installAuthority(
        auth: GomokuAuthority | PlaneHuntAuthority,
        ctx: GameContext,
    ): void {
        const { services: svc } = { services };
        const net = svc.netSync as unknown as {
            setAuthority?: (a: unknown) => void;
            setPlayerId?: (id: string) => void;
            bindOpponent?: (roomId: string, oppId: string) => void;
        };
        if (net.setPlayerId) {
            net.setPlayerId(ctx.myPlayerId);
        }
        if (net.bindOpponent) {
            net.bindOpponent(ctx.room.roomId, ctx.opponent.playerId);
        }
        if (net.setAuthority) {
            net.setAuthority(auth);
            console.log('[GameScene] Mock 权威裁判已装配（AI 经协议通道驱动）');
        }
    }

    // ==================== 计时器 ====================

    private _startTimer(): void {
        this._stopTimer();
        this._remainSec = AppConfig.TURN_TIME_LIMIT_SEC;
        this._timerHandle = setInterval(() => {
            this._remainSec--;
            this._refreshTimer();
            if (this._remainSec <= 0) {
                // 超时：本阶段按「本地提示 + 由权威方判定」处理
                console.warn('[GameScene] 本回合超时');
                this._remainSec = AppConfig.TURN_TIME_LIMIT_SEC;
            }
        }, 1000);
        this._refreshTimer();
    }

    private _stopTimer(): void {
        if (this._timerHandle !== null) {
            clearInterval(this._timerHandle);
            this._timerHandle = null;
        }
    }

    private _refreshTimer(): void {
        if (!this._timerLabel) {
            return;
        }
        this._timerLabel.string = `${displayNumber(this._remainSec)}s`;
        this._timerLabel.color = this._remainSec <= AppConfig.TURN_TIME_WARN_SEC ? THEME.danger : THEME.text;
    }

    /** 回合切换时重置计时。 */
    private _resetTimer(): void {
        this._remainSec = AppConfig.TURN_TIME_LIMIT_SEC;
        this._turnSeq++;
        this._refreshTimer();
    }

    // ==================== HUD 刷新 ====================

    private _refreshHud(): void {
        const game = this._game;
        if (!game || !this._ctx) {
            return;
        }
        this._renderTurn(game.isMyTurn());
        this._resetTimer();
    }

    /**
     * 渲染「当前是谁的回合」——**回合状态唯一的视觉表达**。
     *
     * 2026-09-24 起棋盘上不再有任何遮罩/「对手思考中」文案（用户要求）：
     *   回合归属统一由本方法表达，棋盘只负责落子与挡误触。
     *
     * 四处同时表达，避免只靠一行文字（手机上容易看漏）：
     *   1. Hud/TurnLabel 文案 + 颜色（我的回合=绿，对手=橙）
     *   2. ◆ 高亮圆点只出现在当前回合方那一栏
     *   3. 当前回合方的**昵称**提色（另一侧压暗）
     *   4. 文案带「请落子 / 请稍候」，把"能不能点棋盘"直接说清楚
     *
     * @returns 状态是否发生变化（用于决定要不要重置倒计时）
     */
    private _renderTurn(myTurn: boolean): boolean {
        let changed = false;

        if (this._turnLabel) {
            const text = myTurn ? '● 你的回合 · 请落子' : '● 对手回合 · 请稍候';
            const color = myTurn ? THEME.success : THEME.warn;
            if (this._turnLabel.string !== text) {
                changed = true;
            }
            this._turnLabel.string = text;
            this._turnLabel.color = color;
        }

        // 高亮圆点：只在当前回合方那栏可见（用空格隐藏，避免动节点树）
        if (this._myTurnMark) {
            this._myTurnMark.string = myTurn ? '◆' : ' ';
        }
        if (this._oppTurnMark) {
            this._oppTurnMark.string = myTurn ? ' ' : '◆';
        }

        // 昵称：当前回合方高亮
        if (this._myNameLabel) {
            this._myNameLabel.color = myTurn ? THEME.primary : THEME.textDim;
        }
        if (this._oppNameLabel) {
            this._oppNameLabel.color = myTurn ? THEME.textDim : THEME.primary;
        }

        return changed;
    }

    /** 定期刷新 HUD（轮询，避免侵入各游戏内部状态机）。 */
    private _hudTick(): void {
        if (!this._game || !this._ctx) {
            return;
        }
        // 回合指示：文案真的变了才重置计时（否则每帧都会重置）
        if (this._renderTurn(this._game.isMyTurn())) {
            this._resetTimer();
        }

        // 得分 + 机头进度（寻机头）
        // ⚠️ 全部经 displayNumber 兜底：这些值来自 Board 的 getter 与云端推送，
        //    一旦某处传进 undefined，`${undefined}` 会渲染成字面量 "undefined"
        //    （2026-09-24 真机反馈的"很多 undefined"）。宁可显示 0。
        if (this._ctx.room.gameId === GameId.PLANE_HUNT) {
            const board = this._boardNode?.getChildByName('PlaneHuntBoard')?.getComponent(PlaneHuntBoard);
            if (board) {
                if (this._myScoreLabel) {
                    this._myScoreLabel.string = displayNumber(board.getMyScore());
                }
                if (this._oppScoreLabel) {
                    this._oppScoreLabel.string = displayNumber(board.getOppScore());
                }
                // 机头进度：已找到 n / 总数（寻机头特有的关键信息 ——
                // 对局何时结束只取决于这个数字，玩家必须随时看得到）
                if (this._headsLabel) {
                    const found = board.getHeadsFound();
                    const total = board.getHeadTotal();
                    const foundText = displayNumber(found);
                    const totalText = displayNumber(total, '?');
                    const text = `已找到机头 ${foundText} / ${totalText}`;
                    if (this._headsLabel.string !== text) {
                        this._headsLabel.string = text;
                    }
                    const safeFound = typeof found === 'number' ? found : 0;
                    const safeTotal = typeof total === 'number' && total > 0 ? total : Infinity;
                    this._headsLabel.color = safeFound >= safeTotal ? THEME.success : THEME.textDim;
                }
            }
        }

        // 结束检测 → 结算
        // 入口处 `_savedRecord` 已是幂等闸：结算过一次就不再进入（弹窗不会重复弹、
        // 战绩不会重复写）。之前「再来一局」的重复弹窗不是这里漏判，而是
        // **场景没重载**导致旧组件继续 update —— 见 _restartGame 的说明。
        if (this._game.isFinished() && !this._savedRecord) {
            const result = this._game.getResult();
            if (result) {
                this._showResult(result);
            }
        }
    }

    // ==================== 交互 ====================

    private _toggleEmotePanel(): void {
        if (this._emotePanel) {
            this._emotePanel.active = !this._emotePanel.active;
        }
    }

    private _sendEmote(emoteId: number): void {
        const game = this._game as GomokuGame | PlaneHuntGame | null;
        if (game && typeof game.sendEmote === 'function') {
            game.sendEmote(emoteId);
        }
        console.log(`[GameScene] 发送表情 ${EMOTES[emoteId] ?? emoteId}`);
        if (this._emotePanel) {
            this._emotePanel.active = false;
        }
        uiManager.toast(`已发送 ${EMOTES[emoteId] ?? ''}`, undefined);
    }

    /**
     * 重新开始：退出当前对局并回到房间（复用房间的「再来一局」语义）。
     * 原设计里的「悔棋」在两款游戏规则中都不支持，故改为重开。
     */
    private _onRestart(): void {
        console.log('[GameScene] 请求重新开始（返回房间）');
        uiManager.gotoLobby();
    }

    private _onSurrender(): void {
        if (!this._game || this._game.isFinished()) {
            return;
        }
        console.log('[GameScene] 玩家投降');
        this._game.surrender();
    }

    /** 显示结算弹窗并写战绩。 */
    private _showResult(result: GameResult): void {
        if (this._savedRecord) {
            return;
        }
        this._savedRecord = true;
        this._stopTimer();

        // 写战绩（经 ICloudService，Mock 阶段写内存 + 日志）
        if (this._ctx) {
            saveMatchRecord(result, this._ctx.myPlayerId, this._ctx.room.roomId).catch((e) =>
                console.error('[GameScene] 写战绩失败:', e),
            );
        }

        uiManager.showResultDialog(result, {
            onRestart: () => {
                this._restartGame();
            },
            onBackToLobby: () => {
                uiManager.gotoLobby();
            },
        });
    }

    /**
     * 再来一局。
     *
     * ⚠️ 必须**重新加载 Game 场景**，不能"复用当前场景"（2026-09-24 真机 bug）：
     *   原实现调 `uiManager.gotoGame({...})`，而 `_load` 里有一道幂等闸
     *   「已在目标场景就跳过」——于是场景根本没重载，只是 `_savedRecord`
     *   被重置回 false。后果连锁三连：
     *     ① 旧对局的 `_game/_rules/棋盘` 原样留着（has 已结束状态）；
     *     ② `update()` 每帧继续 `_hudTick()` → 又走一次 `_showResult`
     *        （日志里「结算弹窗已显示: 胜利」出现两次）；
     *     ③ 用**旧对局**的数据再写一遍 `settleGame` → 云函数 3 秒超时
     *        `-504003 Invoking task timed out`（日志里那条红字）。
     *
     * 所以这里显式 `director.loadScene(Game)` 强制重载：场景 onLoad 会
     * 重新消费参数、重建棋盘与规则实例，`_savedRecord` 等字段随新组件归零。
     * 旧组件的 onDestroy 会退房、停 watch（RoomScene 早已在进对局时停掉）。
     *
     * 房间复用：默认沿用当前房间（AI 练习重开最自然）。若房间已 finished，
     * 服务端 `gomoku_move` 会以「对局已结束」拒绝 —— 这里保留原行为，
     * 由 UIManager 层的直达建房子流程负责"真正开一局新的"。
     */
    private _restartGame(): void {
        console.log('[GameScene] 再来一局（强制重载 Game 场景）');
        uiManager.toast('正在重新开始…', undefined);

        const params = this._ctx;
        if (!params) {
            uiManager.gotoLobby();
            return;
        }
        // 注意：不要在这里重置 _savedRecord —— 本组件马上就会被销毁，
        // 新组件的字段天然是初始值；改了反而会误导后来的人。
        uiManager.reloadGame({
            gameId: params.room.gameId,
            mode: params.mode,
            room: params.room,
        });
    }

    /** 每帧轮询 HUD（对局内保持刷新）。 */
    protected update(_dt: number): void {
        // 每帧检查结束状态（代价极低）；HUD 文本变化才写入，避免频繁 setter
        this._hudTick();
    }
}
