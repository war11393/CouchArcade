/**
 * Loading 场景控制器 —— 微信小游戏【明确的加载页】。
 *
 * ⚠️ UI 是【静态节点】，定义在 tools/ui-trees.js 的 loadingTree()，由 gen-scenes.js
 * 编译进 Loading.scene。本控制器**不再运行时创建 UI**，只负责：
 *   1. 绑定已有节点（按路径查找）
 *   2. 驱动真实进度（资源预加载 + 各初始化阶段）与状态文案
 *   3. 处理版本更新（wx.getUpdateManager 经 IPlatformService）
 *   4. 完成后跳转 Lobby / Room
 *
 * 层级结构（可在编辑器层级管理器中看到）：
 *   Scene
 *    └─ Canvas                [cc.Canvas, cc.UITransform, cc.Widget]
 *        ├─ Bg                [cc.Graphics + UiFill]
 *        ├─ Logo              [UiFill] → LogoText [cc.Label]
 *        ├─ Title             [cc.Label]
 *        ├─ Subtitle          [cc.Label]
 *        ├─ ProgressBarBg     [UiFill, cc.ProgressBar]
 *        │   └─ ProgressBarFill [UiFill]
 *        ├─ ProgressText      [cc.Label]   ← 百分比数字
 *        ├─ Status            [cc.Label]   ← 阶段文案
 *        ├─ Hint              [cc.Label]   ← 卡住兜底提示
 *        ├─ Version           [cc.Label]
 *        ├─ Overlay           （浮层容器，由 UIManager 挂 Toast/弹窗）
 *        ├─ SceneRoot         [LoadingScene]   ← 本脚本
 *        └─ Camera            [cc.Camera]
 *
 * 为什么这一屏是必需的（不是可选装饰）：
 *   · 小游戏冷启动要下载代码包 + 初始化引擎，这段时间屏幕本来是空的；
 *   · 微信要求加载过程有明确的进度反馈与「加载中」状态；
 *   · 版本更新提示也发生在进入业务逻辑之前，只能落在这里。
 */

import { _decorator, Component, Node, ProgressBar, UITransform, Vec3, game, view } from 'cc';
import { AppConfig, AiLevel } from '../config/AppConfig';
import { parseRoomLaunchQuery } from '../core/AppHooks';
import { services, ensureServices } from '../core/ServiceLocator';
import { uiManager } from '../core/UIManager';
import { findNode, requireNode, setLabelText, labelAt } from '../core/UIFactory';
import type { LaunchOptions } from '../core/services/IServices';

const { ccclass } = _decorator;

/** 各阶段在总进度里的权重（合计 1.0），保证进度「有意义」而不是匀速假动画。 */
const STAGE_WEIGHT = {
    BOOT: 0.15, // 引擎/服务就绪
    RESOURCE: 0.35, // 资源预加载
    LOGIN: 0.25, // 静默登录
    CLOUD: 0.15, // 云开发初始化
    UPDATE: 0.10, // 检查更新
} as const;

/** 进度停滞多久后显示兜底提示（毫秒）。 */
const STUCK_HINT_MS = 8000;

@ccclass('LoadingScene')
export class LoadingScene extends Component {
    /** 当前进度（0~1），用于对阶段进度做「只增不减」平滑。 */
    private _progress = 0;
    private _started = false;
    private _barFill: Node | null = null;
    private _fillFullWidth = 480;
    /** 卡住检测：最近一次进度变化的时间戳。 */
    private _lastAdvanceAt = 0;
    /** 更新管理器回调是否已注册（避免重复注册）。 */
    private _updateHooked = false;

    protected async onLoad(): Promise<void> {
        // 服务兜底：确保 ServiceLocator 已注入，并注册应用级钩子
        // （热启动 / 网络恢复 → 断线重连，见 core/AppHooks.ts）
        ensureServices();

        this._bindNodes();
        this._lastAdvanceAt = Date.now();

        // 帧率：微信小游戏显式设置为 60（默认可能 30，影响手感）
        this._applyFrameRate();

        // 卡住检测：定时器常驻，长时间无进展才给用户兜底提示
        this.schedule(this._checkStuck, 1);

        // 延迟启动，确保 Canvas/安全区已就绪
        this.scheduleOnce(() => {
            void this._boot();
        }, 0.1);
    }

    protected onDestroy(): void {
        this.unschedule(this._checkStuck);
        // 注意：热启动（onShow）监听**不在此处注销**。
        // 它由 core/AppHooks.ts 在模块作用域注册，生命周期与整个小游戏一致 ——
        // 若绑定到本场景，gotoLobby/gotoRoom 销毁 Loading 场景后监听就会失效，
        // 导致「后台时点分享卡片」不再生效（这是一个已修的旧问题）。
    }

    /** 绑定静态场景里的节点（缺失只告警不抛错，避免个别节点问题导致整页不可用）。 */
    private _bindNodes(): void {
        this._barFill = findNode(this.node, 'Canvas/ProgressBarBg/ProgressBarFill');

        // 记录填充条满宽，便于按进度缩放
        if (this._barFill) {
            const t = this._barFill.getComponent(UITransform);
            if (t) {
                this._fillFullWidth = t.width;
                // 锚点左对齐，scale.x 表示进度
                t.setAnchorPoint(0, 0.5);
                this._barFill.setPosition(new Vec3(-this._fillFullWidth / 2, 0, 0));
            }
        } else {
            console.warn('[LoadingScene] 未找到 ProgressBarFill 节点，进度条将不显示');
        }

        // 关键节点存在性自检（缺失说明 ui-trees.js 被改坏了，尽早暴露）
        requireNode(this.node, 'Canvas/ProgressText');
        requireNode(this.node, 'Canvas/Status');

        // 版本/模式文案（静态场景里是占位文本，这里按配置刷新）
        const mode = AppConfig.USE_MOCK ? 'Mock 预览模式' : '微信真机模式';
        setLabelText(
            this.node,
            'Canvas/Version',
            `v${AppConfig.APP_VERSION}  |  ${mode}  |  ${AppConfig.DESIGN_WIDTH}x${AppConfig.DESIGN_HEIGHT}`,
        );

        // 初始态：0% + 「正在加载资源…」
        this._setProgress(0, '正在加载资源…');
    }

    /** 帧率设置（小游戏端不设会按默认走，手感偏顿）。 */
    private _applyFrameRate(): void {
        try {
            game.frameRate = AppConfig.FRAME_RATE;
            console.log(`[LoadingScene] 帧率设置为 ${AppConfig.FRAME_RATE}`);
        } catch (err) {
            console.warn('[LoadingScene] 设置帧率失败（忽略）:', err);
        }
    }

    /** 主启动流程：按阶段推进，进度真实反映各阶段完成度。 */
    private async _boot(): Promise<void> {
        if (this._started) return;
        this._started = true;

        try {
            // ---- 阶段 1：引擎/服务就绪 ----
            await this._stage('正在初始化…', STAGE_WEIGHT.BOOT, async () => {
                await this._delay(60);
            });

            // ---- 阶段 2：资源预加载 ----
            await this._stage('正在加载资源…', STAGE_WEIGHT.RESOURCE, async () => {
                await this._preload();
            });

            // ---- 阶段 3：静默登录（经 IAuthService，Mock 阶段本地模拟） ----
            let nickname = '';
            await this._stage('正在登录…', STAGE_WEIGHT.LOGIN, async () => {
                const user = await services.auth.login();
                nickname = user.nickname;
                console.log(`[LoadingScene] 登录完成：${user.nickname} (${user.openid})`);
            });

            // ---- 阶段 4：云开发初始化（Mock 内存 Map；幂等） ----
            await this._stage('正在初始化云服务…', STAGE_WEIGHT.CLOUD, async () => {
                services.cloud.init();
                await this._delay(60);
            });

            // ---- 阶段 5：检查更新（注册 wx.getUpdateManager） ----
            await this._stage('正在检查更新…', STAGE_WEIGHT.UPDATE, async () => {
                this._hookUpdateManager();
                await this._delay(60);
            });

            // ---- 完成：读取启动参数（分享卡片直进房间） ----
            this._setProgress(1, `欢迎，${nickname || '玩家'}`);
            await this._delay(300);

            // 冷启动直达：首屏只处理冷启动参数。
            // 热启动（后台时点新卡片）由 core/AppHooks.ts 的 onShow 监听统一处理 ——
            // 放在那里是刻意的：本场景会被销毁，而 onShow 能力必须贯穿全程。
            const launch = services.platform.getLaunchOptions();
            this._handleColdStart(launch);
        } catch (err) {
            console.error('[LoadingScene] 启动失败:', err);
            this._setProgress(this._progress, `启动失败：${(err as Error).message}`);
            setLabelText(this.node, 'Canvas/Hint', '点击重试');
            // 失败不做静默停留：给一个可点的重试路径
            this._bindRetry();
        }
    }

    /**
     * 处理**冷启动**参数：命中 roomId + gameId 则直进房间，否则进大厅。
     *
     * 解析与校验复用 core/AppHooks.ts 的 parseRoomLaunchQuery，
     * 保证冷/热启动两条路径的规则完全一致（避免一处改了另一处漏改）。
     *
     * 热启动分支不在这里：见 AppHooks.handleHotStart（onShow）。
     */
    private _handleColdStart(launch: LaunchOptions): void {
        const target = parseRoomLaunchQuery(launch.query);

        if (!target) {
            // 无有效房间参数（或参数非法，解析函数已打日志）：进大厅
            uiManager.gotoLobby();
            return;
        }

        console.log(
            `[LoadingScene] 冷启动检测到分享直达：roomId=${target.roomId} gameId=${target.gameId}`,
        );
        uiManager.gotoRoom({
            gameId: target.gameId,
            mode: 'pvp',
            aiLevel: AiLevel.NORMAL,
            joinRoomId: target.roomId,
        });
    }

    /**
     * 资源预加载。
     *
     * 当前项目零外部美术资源（UI 全程序化绘制），所以这里主要是
     * 「把首帧要用到的场景/字体准备好」。真实资源接入后，
     * 把 bundle/图片路径填进 ASSETS 即可，进度会真实反映加载比例。
     */
    private async _preload(): Promise<void> {
        // TODO(art-phase): 有美术资源后改为 resources.loadDir 并接 onProgress
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
            await this._delay(45);
            // 让进度条在「资源阶段」内部也平滑推进
            this._advance(STAGE_WEIGHT.RESOURCE * (i / steps));
        }
    }

    /**
     * 注册微信版本更新检查。
     *
     * 要点（微信官方约束）：
     *   · 小游戏**不支持强制更新**，必须用户确认后 applyUpdate() 重启；
     *   · 首次上传的版本不会触发更新流程；
     *   · Mock 阶段（USE_MOCK）只打印日志，绝不调用任何 wx.* API。
     */
    private _hookUpdateManager(): void {
        if (this._updateHooked) return;
        this._updateHooked = true;

        if (AppConfig.USE_MOCK) {
            console.log('[LoadingScene] 检查更新（Mock 模式跳过真实检查）');
            return;
        }

        const platform = services.platform as unknown as {
            checkUpdate?: (cb: {
                onHasUpdate?: () => void;
                onUpdateReady?: (apply: () => void) => void;
                onUpdateFailed?: () => void;
            }) => void;
        };

        if (typeof platform.checkUpdate !== 'function') {
            console.warn('[LoadingScene] 平台服务未实现 checkUpdate，跳过版本更新检查');
            return;
        }

        try {
            platform.checkUpdate({
                onHasUpdate: () => {
                    this._setHint('发现新版本，正在下载…');
                },
                onUpdateReady: (apply) => {
                    this._setHint('新版本已就绪，即将重启更新');
                    // 用户确认后再重启，符合「小游戏不支持强制更新」的要求
                    uiManager.showChoiceDialog({
                        title: '版本更新',
                        subtitle: '新版本已下载完成',
                        choices: [
                            { label: '立即重启更新', onPick: () => apply() },
                            { label: '稍后再说', onPick: () => this._setHint(' ') },
                        ],
                    });
                },
                onUpdateFailed: () => {
                    this._setHint('更新失败，可继续游戏');
                },
            });
        } catch (err) {
            console.warn('[LoadingScene] 注册更新检查失败（忽略）:', err);
        }
    }

    /** 启动失败时给一个可点重试（避免用户卡在加载页无处可去）。 */
    private _bindRetry(): void {
        const hint = findNode(this.node, 'Canvas/Hint');
        if (!hint) return;
        hint.on(Node.EventType.TOUCH_END, () => {
            this._started = false;
            this._progress = 0;
            setLabelText(this.node, 'Canvas/Hint', ' ');
            void this._boot();
        });
    }

    // ==================== 进度驱动 ====================

    /** 执行一个阶段：先设文案，再跑任务，完成后按权重推进总进度。 */
    private async _stage(text: string, weight: number, task: () => Promise<void>): Promise<void> {
        this._setStatus(text);
        await task();
        this._advance(weight);
    }

    /**
     * 前进指定进度（只增不减）。
     *
     * 「只增不减」很重要：各阶段权重相加为 1，但阶段内部还有细粒度推进，
     * 若允许回退会出现进度条来回抖动（体验上像卡死）。
     */
    private _advance(delta: number): void {
        const next = Math.min(1, this._progress + delta);
        this._setProgress(next, null);
    }

    /**
     * 写入进度与文案。
     *
     * @param p 0~1 的目标进度
     * @param status 若给出则同时更新状态文案；传 null 表示保持原文案
     */
    private _setProgress(p: number, status: string | null): void {
        this._progress = Math.max(this._progress, Math.max(0, Math.min(1, p)));
        const v = this._progress;

        // 进度条填充（scale.x 驱动，避免频繁重建 Graphics）
        if (this._barFill) {
            this._barFill.setScale(new Vec3(Math.max(0.0001, v), 1, 1));
        }
        // 同步 cc.ProgressBar 组件（层级管理器里可见其数值变化）
        this._writeProgressToBar(v);
        // 百分比数字（微信要求「明确进度反馈」的关键可视元素）
        setLabelText(this.node, 'Canvas/ProgressText', `${Math.round(v * 100)}%`);
        // 状态文案
        if (status !== null) {
            this._setStatus(status);
        }

        this._lastAdvanceAt = Date.now();
    }

    /** 同步 cc.ProgressBar 组件的 progress。 */
    private _writeProgressToBar(p: number): void {
        const bg = findNode(this.node, 'Canvas/ProgressBarBg');
        const bar = bg ? bg.getComponent(ProgressBar) : null;
        if (bar) {
            bar.progress = p;
        }
    }

    private _setStatus(text: string): void {
        setLabelText(this.node, 'Canvas/Status', text);
    }

    private _setHint(text: string): void {
        // Label 不接受空串（空串会被校验判为不可见），用单空格占位
        setLabelText(this.node, 'Canvas/Hint', text && text.trim().length > 0 ? text : ' ');
    }

    /**
     * 卡住检测：长时间无进度变化时给出兜底提示。
     *
     * 微信小游戏在弱网/低端机上可能出现「长期无响应」观感，
     * 明确提示可以让用户知道不是死机，也便于客服定位。
     */
    private _checkStuck = (): void => {
        if (this._progress >= 1) return;
        if (Date.now() - this._lastAdvanceAt < STUCK_HINT_MS) return;
        if (labelAt(this.node, 'Canvas/Hint')?.string.trim()) return; // 已有提示不覆盖
        this._setHint('加载较慢，请检查网络后重试');
    };

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ==================== 测试/调试接口 ====================

    /** 供外部（如自测清单）查询状态文案。 */
    public getStatusText(): string {
        return labelAt(this.node, 'Canvas/Status')?.string ?? '';
    }

    /** 供外部查询当前进度百分比文案（如「42%」）。 */
    public getProgressText(): string {
        return labelAt(this.node, 'Canvas/ProgressText')?.string ?? '';
    }

    /** 供外部查询当前进度数值（0~1）。 */
    public getProgress(): number {
        return this._progress;
    }

    /** 保持 view 引用可用（布局换算用）。 */
    public getVisible(): { w: number; h: number } {
        const s = view.getVisibleSize();
        return { w: s.width, h: s.height };
    }
}
