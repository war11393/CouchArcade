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
    Component,
    director,
    Label,
    Node,
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
    makeFullScreen,
} from './UIFactory';
import { FONT, RADIUS, overlayColor } from '../config/UITheme';

const { ccclass } = _decorator;

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
    private _gameParams: GameSceneParams | null = null;
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

    /** 跳转房间（创建/加入/AI 练习）。 */
    public gotoRoom(params: RoomSceneParams): void {
        this._roomParams = params;
        this._gameParams = null;
        this._load(SCENES.ROOM);
    }

    /** 跳转对局。 */
    public gotoGame(params: GameSceneParams): void {
        this._gameParams = params;
        this._load(SCENES.GAME);
    }

    /** 取出并清除 Room 参数。 */
    public consumeRoomParams(): RoomSceneParams | null {
        const p = this._roomParams;
        return p;
    }

    /** 取出并清除 Game 参数。 */
    public consumeGameParams(): GameSceneParams | null {
        const p = this._gameParams;
        return p;
    }

    private _load(scene: SceneName): void {
        console.log(`[UIManager] 切换场景 → ${scene}`);
        if (scene === SCENES.LOADING) {
            // Loading 场景重新加载时用重新启动，避免状态残留
            director.loadScene(scene);
        } else {
            director.loadScene(scene);
        }
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
        return named ?? canvas;
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

        const panelH = 200 + opts.choices.length * 110;
        const panel = createCard('ChoicePanel', 600, panelH);
        maskNode.addChild(panel);

        const titleNode = createLabel('title', opts.title, FONT.h1, THEME.text, 520);
        panel.addChild(titleNode);
        titleNode.setPosition(new Vec3(0, panelH / 2 - 70, 0));

        if (opts.subtitle) {
            const sub = createLabel('sub', opts.subtitle, FONT.sub, THEME.textDim, 520);
            panel.addChild(sub);
            sub.setPosition(new Vec3(0, panelH / 2 - 120, 0));
        }

        // 选项按钮（自上而下排布）：主色淡底 + 主色字（扁平、弱化视觉噪音）
        let y = panelH / 2 - 190;
        for (const c of opts.choices) {
            const btn = createButton(
                `choice_${c.label}`,
                c.label,
                472,
                88,
                () => {
                    maskNode.destroy();
                    c.onPick();
                },
                { fill: THEME.primarySoft, textColor: THEME.primary, fontSize: FONT.sub + 2 },
            );
            panel.addChild(btn);
            btn.setPosition(new Vec3(0, y, 0));
            y -= 110;
        }

        // 取消
        const cancel = createButton(
            'choice_cancel',
            '取消',
            472,
            80,
            () => maskNode.destroy(),
            { fill: THEME.surfaceAlt, textColor: THEME.textDim, fontSize: FONT.sub, border: THEME.border },
        );
        panel.addChild(cancel);
        cancel.setPosition(new Vec3(0, -panelH / 2 + 60, 0));

        // 置顶：只在浮层容器内部置顶（挂 Canvas 会被 GameList 的 Mask 影响）
        maskNode.setSiblingIndex(root.children.length - 1);
        console.log(`[UIManager] 模式选择弹窗已显示：${opts.title}（父节点=${root.name}）`);

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
        const lines = [
            `maskNode: valid=${mask.isValid} active=${mask.activeInHierarchy}`,
            `mask size=${mask.getComponent(UITransform)?.width}x${mask.getComponent(UITransform)?.height} scale=${mask.scale.x}`,
            `mask opacity=${mask.getComponent(UIOpacity)?.opacity ?? 'n/a'} sibling=${mask.getSiblingIndex()}/${root.children.length - 1}`,
            `mask children=${mask.children.length} BlockInputEvents=${hasBlockInput}`,
            `panel size=${panel.getComponent(UITransform)?.width}x${panel.getComponent(UITransform)?.height} scale=${panel.scale.x}`,
            `panel pos=(${panel.position.x},${panel.position.y}) active=${panel.activeInHierarchy}`,
            `visibleSize=${size.width}x${size.height} choices=${choiceCount}`,
            `root=${root.name} rootChildren=${root.children.length}`,
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

        // 蒙层
        const mask = createRect('ResultMask', view.getVisibleSize().width, view.getVisibleSize().height, overlayColor(140));
        root.addChild(mask);
        mask.setPosition(new Vec3(0, 0, 0));
        // 遮罩拦截点击，避免误触底下棋盘（BlockInputEvents 比裸 UITransform 可靠）
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
