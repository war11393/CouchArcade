/**
 * UI 与场景管理器。
 *
 * 职责：
 * - 场景路由（Loading → Lobby → Room → Game，含跨场景参数传递）；
 * - 全局 Toast 提示；
 * - 结算弹窗（通用，两款游戏共用）；
 * - 跨场景数据（当前房间、当前对局配置）的中转存储。
 *
 * 场景参数传递说明：Cocos 的 director.loadScene 不直接支持传参，
 * 因此用本类的 _pending 字段做中转（单线程流程，安全）。
 */

import {
    BlockInputEvents,
    Camera,
    director,
    Label,
    Layers,
    Mask,
    MaskType,
    Node,
    ScrollView,
    UIOpacity,
    UITransform,
    Vec3,
    Widget,
    view,
    _decorator,
} from 'cc';
import { AppConfig, AiLevel } from '../config/AppConfig';
import { GameId } from '../config/GameList';
import { GameResult } from '../games/common/IGame';
import { RoomState } from './services/IServices';
import { GameEvent, ToastLevel, ToastPayload, eventBus } from './EventBus';
import {
    THEME,
    createButton,
    createCard,
    createLabel,
    createRect,
    newUINode,
} from './UIFactory';
import { FONT, RADIUS, overlayColor } from '../config/UITheme';
import { services } from './ServiceLocator';

/** 场景名常量（与 assets/scenes/ 下的场景文件一一对应）。 */
export const SCENES = {
    LOADING: 'Loading',
    LOBBY: 'Lobby',
    ROOM: 'Room',
    GAME: 'Game',
} as const;

export type SceneName = (typeof SCENES)[keyof typeof SCENES];

/** 进入 Room 场景所需的参数。 */
export interface RoomSceneParams {
    gameId: GameId;
    mode: 'pvp' | 'ai';
    aiLevel: AiLevel;
    /** 直进房间（分享卡片）时的房间号 */
    joinRoomId?: string;
}

/** 进入 Game 场景所需的参数。 */
export interface GameSceneParams {
    gameId: GameId;
    mode: 'pvp' | 'ai';
    /** 房间快照（对局上下文） */
    room: RoomState;
}

/**
 * UI 管理器（全局单例，非 Component，由场景控制器调用）。
 */
export class UIManager {
    private static _inst: UIManager | null = null;

    /** 跨场景参数中转。 */
    private _roomParams: RoomSceneParams | null = null;
    /**
     * 待消费的对局参数。
     *
     * 允许是**函数**（懒求值）：AI 练习需要先建房才知道 roomId，
     * 而建房是异步云函数调用 —— 见 gotoGame / gotoAiPractice 的说明。
     */
    private _gameParams: GameSceneParams | (() => Promise<GameSceneParams>) | null = null;
    /** 当前 Toast 节点。 */
    private _toastNode: Node | null = null;

    public static get instance(): UIManager {
        if (!UIManager._inst) {
            UIManager._inst = new UIManager();
        }
        return UIManager._inst;
    }

    // ==================== 场景路由 ====================

    /** 跳转 Loading（重启入口）。 */
    public gotoLoading(): void {
        this._roomParams = null;
        this._gameParams = null;
        this._load(SCENES.LOADING);
    }

    /** 跳转大厅。 */
    public gotoLobby(): void {
        this._roomParams = null;
        this._gameParams = null;
        this._load(SCENES.LOBBY);
    }

    /** 跳转房间（创建/加入）。 */
    public gotoRoom(params: RoomSceneParams): void {
        this._roomParams = params;
        this._gameParams = null;
        this._load(SCENES.ROOM);
    }

    /**
     * 跳转对局。
     *
     * `params` 支持传函数：在目标场景 `onLoad` 里**消费参数时**才求值。
     *
     * 为什么需要这个（2026-09-24「AI 练习不要闪房间页」）：
     *   AI 练习的房间是**服务端建房时**才有 roomId 的，而建房本身是异步云函数调用。
     *   若在点击那一刻 `await createRoom()` 再把结果塞进参数，玩家会先在大厅里
     *   干等一次网络往返（按钮点了没反应，观感更差）；
     *   而经 Room 场景中转，则一定会闪一下房间页（本需求的直接原因）。
     *   传函数可以让 Game 场景**先加载、再取房间**——画面立刻出现，
     *   异步建房在 `onLoad` 内完成，两边都不耽误。
     */
    public gotoGame(params: GameSceneParams | (() => Promise<GameSceneParams>)): void {
        this._gameParams = params;
        this._load(SCENES.GAME);
    }

    /**
     * AI 练习直达：**建房 + 开局 + 进对局**，全程不经过房间页。
     *
     * 为什么放在 UIManager 而不是 LobbyScene（2026-09-24）：
     *   这段逻辑原先散在 RoomScene（建房 → watch → 自动开局 → 切场景），
     *   而「AI 练习不该看到房间页」这个需求要求它**能在没有 Room 场景的情况下**
     *   跑完。放进 UIManager 后，大厅只需一行调用，将来「再来一局」也能复用。
     *
     * 流程（与服务端能力一一对应，缺一不可）：
     *   1. createRoom(practice=true)  —— 服务端建库并**同时**填入 AI 座位（isAI + ready）
     *   2. startGame                  —— 服务端生成 seed、建 games_gomoku 空棋局、rooms 置 playing
     *   3. getRoomState               —— 取一份**权威**房间快照（含 AI 座位的 playerId）
     *   4. gotoGame(懒加载函数)        —— 参数在 Game.onLoad 里求值，画面先出、房间后到
     *
     * ⚠️ 第 3 步不能省：AI 座位的 playerId（`ai-<roomId>-1`）是**服务端建房时**
     *    生成的，客户端不拉快照就无从得知对手是谁，GameContext.opponent 会是空的。
     *
     * 失败处理：任一步失败都回大厅并 toast，不把玩家留在半初始化状态。
     */
    public async gotoAiPractice(gameId: GameId, aiLevel: AiLevel): Promise<void> {
        services.room.leaveRoom().catch(() => undefined);
        try {
            await services.room.createRoom(gameId, true, aiLevel);
            await services.room.startRoom();
            const room = await services.room.getRoomState();
            if (!room) {
                throw new Error('房间快照为空（可能已被解散）');
            }
            console.log(
                `[UIManager] AI 练习直达：roomId=${room.roomId} 状态=${
                    room.status
                } 座位=${room.seats.map((s) => `${s.nickname}${s.isAI ? '[AI]' : ''}`).join(',')}`,
            );
            this.gotoGame({ gameId, mode: 'ai', room });
        } catch (err) {
            console.error('[UIManager] AI 练习直达失败:', err);
            this.toast(`AI 练习启动失败：${(err as Error).message}`, ToastLevel.ERROR);
            this.gotoLobby();
        }
    }

    /** 取出并清除 Room 参数。 */
    public consumeRoomParams(): RoomSceneParams | null {
        const p = this._roomParams;
        return p;
    }

    /**
     * 强制重新加载对局场景（「再来一局」专用）。
     *
     * 与 gotoGame 的唯一区别：**绕过 `_load` 的「已在目标场景就跳过」幂等闸**。
     * 那道闸是为「两条并行路径都跑到 gotoLobby」设计的，但「再来一局」恰恰
     * 需要**在同一个场景里重开**——复用场景会让旧对局的控制器与已结束状态
     * 原样活着，于是重复结算、并用旧数据再写一次战绩（云函数 3s 超时）。
     */
    public reloadGame(params: GameSceneParams): void {
        this._gameParams = params;
        const cur = director.getScene();
        console.log(
            `[UIManager] 强制重载场景 → ${SCENES.GAME}（当前场景=${cur ? cur.name : 'null'}，绕过幂等闸）`,
        );
        director.loadScene(SCENES.GAME);
    }

    /**
     * 取出并清除 Game 参数。
     *
     * ⚠️ 现在是 async：参数允许是一个「建房/准备房间」的异步函数（见 gotoGame）。
     *    Room 场景是同步消费的（onLoad 非 async 分支），那边传的是普通对象，
     *    await 一个非 thenable 值会原样返回，行为不变。
     */
    public async consumeGameParams(): Promise<GameSceneParams | null> {
        const p = this._gameParams;
        if (typeof p === 'function') {
            return await p();
        }
        return p;
    }

    private _load(scene: SceneName): void {
        const cur = director.getScene();

        // 幂等：已经在目标场景里就什么都不做。
        // 真实场景：LoadingScene 降级放行（_degradeToLobby）与冷启动直达是
        // 两条并行路径，若都跑到 gotoLobby，第二次 loadScene 会把刚建好的
        // 大厅整个拆掉重建 —— 表现为「大厅闪一下又回到加载画面」。
        if (cur && cur.name === scene) {
            console.log(`[UIManager] 已在场景 ${scene}，跳过重复切换`);
            return;
        }

        console.log(
            `[UIManager] 切换场景 → ${scene}（当前场景=${cur ? cur.name : 'null'}）`,
        );
        director.loadScene(scene);
    }

    // ==================== Toast ====================

    /** 弹出全局提示。 */
    public toast(text: string, level: ToastLevel = ToastLevel.INFO): void {
        const payload: ToastPayload = { text, level };
        eventBus.emit(GameEvent.TOAST, payload);
        console.log(`[Toast][${level}] ${text}`);
        this._showToast(payload);
    }

    /**
     * 取当前场景的【浮层容器】。
     *
     * 为什么不用 Canvas 直接挂（真实踩坑，症状是「点了按钮没反应」）：
     *   大厅的 `GameList/view` 挂了 `cc.Mask`（ScrollView 裁剪），
     *   ScrollView 还设了 `cancelInnerEvents = true`。
     *   把 Toast/弹窗直接 addChild 到 Canvas 并 setSiblingIndex 置顶时：
     *     · 会被 Mask 的裁剪矩形影响（弹窗被裁掉 → 屏幕上什么都没有，
     *       但控制台有 `[LobbyScene] 选择游戏：xxx` 日志，极易误判成「点击无效」）；
     *     · setSiblingIndex 还可能插到 Camera 之后，事件/渲染顺序更乱。
     *   所以每个场景用静态 UI 树里的 `Canvas/Overlay` 作为浮层父节点
     *   （见 tools/ui-trees.js 的 overlayNode）；缺失时降级为 Canvas，保证不崩。
     */
    private _overlayRoot(canvas: Node): Node {
        const named = canvas.getChildByName('Overlay');
        const root = named ?? canvas;
        // 兜底：浮层容器必须是 UI_2D 层。若它是 DEFAULT 层（例如被编辑器误改、
        // 或将来换成预制体），挂在它下面的所有运行时节点的渲染与点击都会静默失效。
        // 这里不做递归改子节点（子节点由各自的 newUINode 保证），只修容器自身。
        if (root.layer !== Layers.Enum.UI_2D) {
            console.warn(
                `[UIManager] 浮层容器 ${root.name} 层级异常(${root.layer})，已强制改为 UI_2D`,
            );
            root.layer = Layers.Enum.UI_2D;
        }
        return root;
    }

    /**
     * 直接创建 Toast 节点（不依赖各场景预置监听，保证任何场景都能提示）。
     */
    private _showToast(payload: ToastPayload): void {
        const scene = director.getScene();
        if (!scene) {
            return;
        }
        const canvas = this._findCanvas(scene);
        if (!canvas) {
            return;
        }
        const root = this._overlayRoot(canvas);

        // 覆盖上一个 Toast
        if (this._toastNode && this._toastNode.isValid) {
            this._toastNode.destroy();
            this._toastNode = null;
        }

        // 扁平提示条：深色胶囊（浅色界面里对比最稳）+ 白字；错误/警告换成语义色胶囊
        const color =
            payload.level === ToastLevel.ERROR
                ? THEME.danger
                : payload.level === ToastLevel.WARN
                  ? THEME.warn
                  : THEME.toastBg;

        const node = createRect('Toast', 560, 84, color, RADIUS.pill);
        root.addChild(node);
        node.setPosition(new Vec3(0, -view.getVisibleSize().height * 0.3, 0));

        const label = createLabel('Toast_label', payload.text, FONT.body, THEME.onPrimary, 520);
        node.addChild(label);
        label.setPosition(new Vec3(0, 0, 0));

        // 置顶（限制在浮层容器内部，避免插到 Camera 之后）
        node.setSiblingIndex(root.children.length - 1);
        this._toastNode = node;

        // 2 秒后自动消失
        setTimeout(() => {
            if (node.isValid) {
                node.destroy();
            }
            if (this._toastNode === node) {
                this._toastNode = null;
            }
        }, 2000);
    }

    // ==================== 选项弹窗（模式选择等运行时浮层） ====================
    //
    // 说明：大厅的「创建/加入/AI 练习」弹窗内容随所选游戏变化，不适合静态化，
    // 因此保留为运行时浮层（与 Toast 同属临时 UI，不进场景树的常态）。
    // 主界面（Header/列表/卡片/按钮）全部是 .scene 里的静态节点。

    /**
     * 显示一个多选项弹窗。
     *
     * @param opts.title 标题
     * @param opts.subtitle 副标题
     * @param opts.choices 选项列表（label + 点击回调）
     */
    public showChoiceDialog(opts: {
        title: string;
        subtitle?: string;
        choices: Array<{ label: string; onPick: () => void }>;
    }): void {
        const scene = director.getScene();
        if (!scene) return;
        const canvas = this._findCanvas(scene);
        if (!canvas) return;
        const root = this._overlayRoot(canvas);

        const size = view.getVisibleSize();

        // 蒙层（点击不穿透）；颜色取设计令牌 overlay 基色 + alpha
        const maskNode = createRect('ChoiceMask', size.width, size.height, overlayColor(120));
        root.addChild(maskNode);
        maskNode.setPosition(new Vec3(0, 0, 0));
        // 拦住蒙层范围内的所有触摸：否则点击会穿透到下层卡片，
        // 出现「弹窗上的点击又触发了一次开始游戏」的诡异行为。
        maskNode.addComponent(BlockInputEvents);

        // ---------- 尺寸规格（改小 + 分区，消除「选项压住取消按钮」） ----------
        const PANEL_W = 600;
        const BTN_W = 440;
        /** 单个选项按钮高（原 88 偏大，收紧到 72） */
        const OPT_H = 72;
        /** 选项间距 */
        const OPT_GAP = 14;
        /** 选项区最大高度：超出即滚动 */
        const OPT_VIEW_H = 300;
        const titleBlockH = 120; // 标题 + 副标题
        const cancelBlockH = 104; // 取消按钮 + 上下留白

        const contentH = opts.choices.length * OPT_H + Math.max(0, opts.choices.length - 1) * OPT_GAP;
        const viewH = Math.min(OPT_VIEW_H, Math.max(OPT_H, contentH));
        const panelH = titleBlockH + viewH + cancelBlockH;

        const panel = createCard('ChoicePanel', PANEL_W, panelH);
        maskNode.addChild(panel);

        // 标题区（面板顶部，居中）
        const topY = panelH / 2;
        const titleNode = createLabel('title', opts.title, FONT.h1, THEME.text, PANEL_W - 80);
        panel.addChild(titleNode);
        titleNode.setPosition(new Vec3(0, topY - 62, 0));

        if (opts.subtitle) {
            const sub = createLabel('sub', opts.subtitle, FONT.sub, THEME.textDim, PANEL_W - 80);
            panel.addChild(sub);
            sub.setPosition(new Vec3(0, topY - 104, 0));
        }

        // ---------- 选项区：ScrollView（纵向，超长才滚动） ----------
        //
        // 为什么用 ScrollView 而不是直接排布：
        //   选项数量/文案长度都是「配置驱动」的，将来可能加「人机难度」「好友房」
        //   等更多入口。直接绝对定位排布时，选项一多就会压到下面的取消按钮上
        //   （本项目真实出现过）。用可滚动容器后，无论多少个选项都不会越界，
        //   且面板总高有上界，不会顶到屏幕外。
        const viewY = topY - titleBlockH - viewH / 2;
        const svRoot = newUINode('ChoiceOptionsView');
        panel.addChild(svRoot);
        svRoot.setPosition(new Vec3(0, viewY, 0));
        const svUT = svRoot.addComponent(UITransform);
        svUT.setContentSize(PANEL_W, viewH);

        // ScrollView 需要一个带 Mask 的 view 子节点承载 content
        const viewNode = newUINode('view');
        svRoot.addChild(viewNode);
        const viewUT = viewNode.addComponent(UITransform);
        viewUT.setContentSize(PANEL_W, viewH);
        viewUT.setAnchorPoint(0.5, 0.5);
        viewNode.addComponent(Mask).type = MaskType.GRAPHICS_RECT;

        // content：锚点顶部居中，向下排布（ScrollView 的标准用法）
        const content = newUINode('content');
        viewNode.addChild(content);
        const contentUT = content.addComponent(UITransform);
        contentUT.setAnchorPoint(0.5, 1);
        contentUT.setContentSize(PANEL_W, Math.max(contentH, 1));
        content.setPosition(new Vec3(0, viewH / 2, 0));

        const sv = svRoot.addComponent(ScrollView);
        sv.content = content;
        sv.horizontal = false;
        sv.vertical = true;
        sv.inertia = true;
        sv.elastic = true;
        sv.brake = 0.5;
        // 短按不应被滚动吞掉：cancelInnerEvents 仅在真的发生滚动时才取消
        sv.cancelInnerEvents = true;

        // 选项按钮（自上而下）：主色淡底 + 主色字（扁平、弱化视觉噪音）
        opts.choices.forEach((c, i) => {
            const btn = createButton(
                `choice_${i}_${c.label}`,
                c.label,
                BTN_W,
                OPT_H,
                () => {
                    console.log(`[UIManager] 弹窗选项被点击：${c.label}`);
                    maskNode.destroy();
                    c.onPick();
                },
                { fill: THEME.primarySoft, textColor: THEME.primary, fontSize: FONT.sub + 2 },
            );
            content.addChild(btn);
            // content 锚点 (0.5, 1) → 第一个选项中心在 -OPT_H/2
            btn.setPosition(new Vec3(0, -OPT_H / 2 - i * (OPT_H + OPT_GAP), 0));
        });

        // ScrollView 需要 Layout 或手动尺寸都行；这里手动定位，故不加 Layout，
        // 但要确保 content 高度正确（上面已按内容算好）。

        // ---------- 取消按钮（独立在面板底部，绝不会被选项压住） ----------
        const cancel = createButton(
            'choice_cancel',
            '取消',
            BTN_W,
            68,
            () => maskNode.destroy(),
            { fill: THEME.surfaceAlt, textColor: THEME.textDim, fontSize: FONT.sub, border: THEME.border },
        );
        panel.addChild(cancel);
        cancel.setPosition(new Vec3(0, -panelH / 2 + 56, 0));

        // 置顶：只在浮层容器内部置顶（挂 Canvas 会被 GameList 的 Mask 影响）
        maskNode.setSiblingIndex(root.children.length - 1);
        console.log(
            `[UIManager] 模式选择弹窗已显示：${opts.title}（父节点=${root.name}）` +
                ` 选项=${opts.choices.length} 面板高=${panelH} 选项区高=${viewH} ` +
                `内容高=${contentH} ${contentH > viewH ? '(需滚动)' : '(无需滚动)'}`,
        );

        // ---- 诊断（临时）：把运行时真实状态打到屏幕上，便于一次预览定位问题 ----
        if (AppConfig.SHOW_DIALOG_DEBUG) {
            this._showDialogDebug(root, maskNode, panel, size, opts.choices.length);
        }
    }

    /**
     * 临时诊断：把弹窗的实际运行时状态显示在屏幕上。
     *
     * 为什么需要它：弹窗「不显示」有多种原因（父节点错、尺寸为 0、缩放为 0、
     * 被裁剪、透明度为 0），光看控制台日志无法区分。把关键数值直接画在屏幕上，
     * 一次预览就能定位，比反复猜测快得多。
     *
     * 用 AppConfig.SHOW_DIALOG_DEBUG 开关，定位完即可关掉。
     */
    private _showDialogDebug(root: Node, mask: Node, panel: Node, size: { width: number; height: number }, choiceCount: number): void {
        const hasBlockInput = !!mask.getComponent(BlockInputEvents);
        const cam = this._findCamera();
        const camVis = cam ? cam.visibility : -1;
        // 相机可见性掩码检查：DEFAULT 层(1<<30)不在 UI_2D|UI_3D 内，
        // 若这里报「不可见」，说明有节点没走 UIFactory 的 newUINode。
        const ui2d = Layers.Enum.UI_2D;
        const layers = [
            ['root', root],
            ['mask', mask],
            ['panel', panel],
        ] as Array<[string, Node]>;
        const layerLines = layers.map(([n, node]) => {
            const ok = (node.layer & camVis) !== 0;
            const isUI2D = node.layer === ui2d;
            return `${n}.layer=${node.layer}${isUI2D ? '(UI_2D✓)' : '(非UI_2D✗)'} 相机可见=${ok ? '是✓' : '否✗'}`;
        });
        const lines = [
            `maskNode: valid=${mask.isValid} active=${mask.activeInHierarchy}`,
            `mask size=${mask.getComponent(UITransform)?.width}x${mask.getComponent(UITransform)?.height} scale=${mask.scale.x}`,
            `mask opacity=${mask.getComponent(UIOpacity)?.opacity ?? 'n/a'} sibling=${mask.getSiblingIndex()}/${root.children.length - 1}`,
            `mask children=${mask.children.length} BlockInputEvents=${hasBlockInput}`,
            `panel size=${panel.getComponent(UITransform)?.width}x${panel.getComponent(UITransform)?.height} scale=${panel.scale.x}`,
            `panel pos=(${panel.position.x},${panel.position.y}) active=${panel.activeInHierarchy}`,
            `visibleSize=${size.width}x${size.height} choices=${choiceCount}`,
            `root=${root.name} rootChildren=${root.children.length}`,
            `相机可见性掩码=${camVis}`,
            ...layerLines,
        ];
        const node = createRect('DialogDebug', size.width, lines.length * 34 + 20, THEME.toastBg);
        root.addChild(node);
        node.setPosition(new Vec3(0, 0, 0));
        node.setSiblingIndex(root.children.length - 1);

        lines.forEach((text, i) => {
            const l = createLabel(`dbg_${i}`, text, 18, THEME.onPrimary, size.width - 20);
            node.addChild(l);
            const y = (lines.length - 1) * 17 - i * 34;
            l.setPosition(new Vec3(0, y, 0));
            const lt = l.getComponent(UITransform);
            if (lt) lt.setContentSize(size.width - 20, 30);
        });
        console.log('[UIManager] 弹窗诊断已显示（AppConfig.SHOW_DIALOG_DEBUG=true）');
        console.log('[UIManager] 弹窗层级诊断:\n  ' + lines.slice(-4).join('\n  '));
    }

    /** 找当前场景的 UI 相机（用于诊断相机可见性）。 */
    private _findCamera(): Camera | null {
        const scene = director.getScene();
        if (!scene) return null;
        const stack: Node[] = [...scene.children];
        while (stack.length > 0) {
            const n = stack.shift()!;
            const c = n.getComponent(Camera);
            if (c) return c;
            stack.push(...n.children);
        }
        return null;
    }

    // ==================== 结算弹窗 ====================

    /**
     * 显示结算弹窗（两款游戏共用）。
     *
     * @param result 对局结果
     * @param callbacks 按钮回调：再来一局 / 返回大厅
     */
    public showResultDialog(
        result: GameResult,
        callbacks: { onRestart: () => void; onBackToLobby: () => void },
    ): void {
        const scene = director.getScene();
        if (!scene) {
            return;
        }
        const canvas = this._findCanvas(scene);
        if (!canvas) {
            return;
        }
        const root = this._overlayRoot(canvas);

        // 点击拦截层（**不可见**）。
        //
        // 原实现这里是一块 overlayColor(140) 的灰色蒙版，需求改为「不显示灰色蒙版，
        // 只显示结果白卡片」。但拦截层不能直接删掉：
        //   · 它是 ResultPanel 的父节点（面板靠它居中，删了面板就没地方挂）；
        //   · 它挡住底下棋盘的点击，否则结算时还能误触落子。
        // 解法：容器保留、尺寸铺满，但**不画任何底色**（alpha=0）。
        // 注意不能用 node.active=false —— 那会连同子节点（白卡片）一起隐藏。
        const mask = createRect('ResultMask', view.getVisibleSize().width, view.getVisibleSize().height, overlayColor(0));
        root.addChild(mask);
        mask.setPosition(new Vec3(0, 0, 0));
        // BlockInputEvents 比裸 UITransform 可靠 —— 没有它点击会穿透到棋盘
        mask.addComponent(BlockInputEvents);

        const myStat = result.stats[0];
        const oppStat = result.stats[1];
        const isWin = result.winnerId !== '' && result.stats.length > 0 && result.winnerId === myStat.playerId;
        const isDraw = result.draw;

        const title = isDraw ? '平  局' : isWin ? '胜  利' : '失  败';
        const titleColor = isDraw ? THEME.warn : isWin ? THEME.success : THEME.danger;

        // 面板（白底 + 1px 细边，与静态场景卡片同规范）
        const panel = createCard('ResultPanel', 600, 560);
        mask.addChild(panel);
        panel.setPosition(new Vec3(0, 0, 0));

        // 标题
        const titleLabel = createLabel('title', title, FONT.display, titleColor, 520);
        panel.addChild(titleLabel);
        titleLabel.setPosition(new Vec3(0, 190, 0));

        // 结束原因
        const reasonText = this._reasonText(result.reason);
        const reasonLabel = createLabel('reason', reasonText, FONT.sub, THEME.textDim, 520);
        panel.addChild(reasonLabel);
        reasonLabel.setPosition(new Vec3(0, 130, 0));

        // 对局数据
        const detail = [
            `${myStat.nickname}  ${result.gameId === GameId.PLANE_HUNT ? `得分 ${myStat.score}` : `${myStat.moves} 手`}`,
            `${oppStat.nickname}  ${result.gameId === GameId.PLANE_HUNT ? `得分 ${oppStat.score}` : `${oppStat.moves} 手`}`,
            `时长 ${(result.durationMs / 1000).toFixed(1)} 秒`,
        ].join('\n');
        const detailLabel = createLabel('detail', detail, FONT.body, THEME.text, 500);
        panel.addChild(detailLabel);
        detailLabel.setPosition(new Vec3(0, 20, 0));
        detailLabel.getComponent(Label)!.lineHeight = 44;

        // 按钮：再来一局（主按钮实心）
        const btnRestart = createButton('btnRestart', '再来一局', 400, 88, () => {
            mask.destroy();
            callbacks.onRestart();
        }, { fill: THEME.primary, textColor: THEME.onPrimary });

        // 按钮：返回大厅（次按钮：白底 + 描边）
        const btnLobby = createButton('btnLobby', '返回大厅', 400, 88, () => {
            mask.destroy();
            callbacks.onBackToLobby();
        }, { fill: THEME.surface, textColor: THEME.text, border: THEME.border });

        panel.addChild(btnRestart);
        panel.addChild(btnLobby);
        btnRestart.setPosition(new Vec3(0, -110, 0));
        btnLobby.setPosition(new Vec3(0, -215, 0));

        // 置顶（限制在浮层容器内部）
        mask.setSiblingIndex(root.children.length - 1);
        mask.setScale(new Vec3(0.85, 0.85, 1));
        const op = mask.addComponent(UIOpacity);
        op.opacity = 255;
        console.log('[UIManager] 结算弹窗已显示:', title);
    }

    private _reasonText(reason: GameResult['reason']): string {
        switch (reason) {
            case 'win':
                return '连成五子 / 机头数领先';
            case 'draw':
                return '双方战平';
            case 'surrender':
                return '有一方投降';
            case 'timeout':
                return '超时判负';
            case 'offline':
                return '对方掉线';
            case 'leave':
                return '对方退出对局';
            default:
                return '';
        }
    }

    /** 查找场景中的 Canvas 节点（优先名为 Canvas 的节点）。 */
    private _findCanvas(scene: { getChildByName?: (n: string) => Node | null; children: Node[] }): Node | null {
        const named = scene.getChildByName ? scene.getChildByName('Canvas') : null;
        if (named) {
            return named;
        }
        for (const c of scene.children) {
            if (c.getComponent(Camera) || c.getComponent(Widget)) {
                return c;
            }
        }
        return scene.children.length > 0 ? scene.children[0] : null;
    }

    /** 清理（退出登录/重启）。 */
    public reset(): void {
        this._roomParams = null;
        this._gameParams = null;
        if (this._toastNode && this._toastNode.isValid) {
            this._toastNode.destroy();
        }
        this._toastNode = null;
    }
}

export const uiManager = UIManager.instance;

/**
 * 类型占位：供各场景在「未使用引用」处引用，避免 import 被裁剪工具误删。
 * （不使用 Component 作为值，避免误当类型使用。）
 */
export type UiManagerRefStub = typeof UIManager;
