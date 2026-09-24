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
 *        ├─ Footer              [贴底容器 cc.Widget]
 *        │   └─ Version           [cc.Label]
 *        ├─ Overlay           （浮层容器，由 UIManager 挂 Toast/弹窗）
 *        ├─ SceneRoot         [LoadingScene]   ← 本脚本
 *        └─ Camera            [cc.Camera]
 *
 * 为什么这一屏是必需的（不是可选装饰）：
 *   · 小游戏冷启动要下载代码包 + 初始化引擎，这段时间屏幕本来是空的；
 *   · 微信要求加载过程有明确的进度反馈与「加载中」状态；
 *   · 版本更新提示也发生在进入业务逻辑之前，只能落在这里。
 */

import { _decorator, Component, Node, ProgressBar, UITransform, Vec3, assetManager, game, view } from 'cc';
import { AppConfig, AiLevel } from '../config/AppConfig';
import { parseRoomLaunchQuery, onUpdateStateChange } from '../core/AppHooks';
import { services, ensureServices } from '../core/ServiceLocator';
import { uiManager } from '../core/UIManager';
import { findNode, requireNode, setLabelText, labelAt } from '../core/UIFactory';
import { portraitAdapter } from '../core/PortraitAdapter';
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
    /** 版本更新状态订阅的退订函数（onDestroy 里必须调用）。 */
    private _unsubscribeUpdate: (() => void) | null = null;

    protected async onLoad(): Promise<void> {
        // 服务兜底：确保 ServiceLocator 已注入，并注册应用级钩子
        // （热启动 / 网络恢复 → 断线重连，见 core/AppHooks.ts）
        ensureServices();

        // 竖版自适应：先按当前机型重算设计分辨率，再把安全区避让推给贴边条。
        // 必须早于任何按布局排布的动作（见 core/PortraitAdapter.ts）。
        portraitAdapter.apply();
        portraitAdapter.applyEdgeInsets(this.node);

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
        // 退订版本更新状态，避免本组件销毁后仍被回调（更新回调是长存活的）
        if (this._unsubscribeUpdate) {
            try {
                this._unsubscribeUpdate();
            } catch (err) {
                console.warn('[LoadingScene] 退订版本更新状态失败:', err);
            }
            this._unsubscribeUpdate = null;
        }
        // 注意：热启动（onShow）监听**不在此处注销**。
        // 它由 core/AppHooks.ts 在模块作用域注册，生命周期与整个小游戏一致 ——
        // 若绑定到本场景，gotoLobby/gotoRoom 销毁 Loading 场景后监听就会失效，
        // 导致「后台时点分享卡片」不再生效（这是一个已修的旧问题）。
    }

    /** 绑定静态场景里的节点（缺失只告警不抛错，避免个别节点问题导致整页不可用）。 */
    private _bindNodes(): void {
        this._barFill = findNode(this.node, 'Canvas/ProgressBarBg/ProgressBarFill');

        // ⚠️ 必须绑定重试交互（2026-09-24 修复：此前 _bindRetry 定义了却从未调用，
        //    等于「登录失败时没有任何手动重试入口」——玩家若卡在加载页只能杀进程）。
        //    绑定本身是幂等的：hint 节点的 TOUCH_END 只注册一次。
        this._bindRetry();

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
        //
        // 尺寸一项在自适应方案下不能写 AppConfig 的静态常量（那是设计期基准，
        // 不代表当前机型）——改为报实际生效的设计分辨率，才能在真机上验证
        // 「竖版自适应是否按预期算出了高度」。
        const mode = AppConfig.USE_MOCK ? 'Mock 预览模式' : '微信真机模式';
        const vs = portraitAdapter.layout;
        setLabelText(
            this.node,
            'Canvas/Footer/Version',
            `v${AppConfig.APP_VERSION}  |  ${mode}  |  ${vs.designW}x${vs.designH}`,
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
            // 走到这里说明**核心链路**失败（登录已自带三级兜底，正常不会抛）。
            //
            // 关键取舍：**不再卡在加载页**。原先只是把「启动失败：xxx」写进 Status
            // 就停住 —— 用户看到的就是一个永远停在加载页、只有一行字的死界面，
            // 既进不了大厅也看不出能做什么。现在改为降级放行：进大厅（单机可玩），
            // 并用 Toast 明确告知异常，把「能不能玩」与「服务端是否正常」解耦。
            console.error('[LoadingScene] 启动失败:', err);
            this._degradeToLobby(err);
        }
    }

    /**
     * 启动失败时的降级放行：提示 + 进大厅。
     *
     * 为什么不留在加载页重试：加载页的重试按钮是「同一个必失败的动作再来一次」，
     * 用户点几次就放弃了。进大厅后单机（AI 练习）与本地缓存功能都可用，
     * 用户至少能玩到东西 —— 这才是失败的合理下限。
     */
    private _degradeToLobby(err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        this._setProgress(this._progress, '启动异常，已进入离线模式');
        setLabelText(this.node, 'Canvas/Hint', '启动异常（详见控制台）');

        // Toast 走 UIManager 的运行时浮层（静态场景里没有 Toast 节点）；
        // 失败也不该反过来影响跳转，单独 try 住。
        try {
            uiManager.toast(`启动异常：${msg}`, undefined);
        } catch (e) {
            console.warn('[LoadingScene] 降级提示显示失败（忽略）:', e);
        }

        // 留一小段时间让用户看见状态文案，再进大厅
        this.scheduleOnce(() => {
            uiManager.gotoLobby();
        }, 0.8);
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
     * 当前项目零外部美术资源（UI 全程序化绘制），所以这里加载的是
     * **首帧要用到的内置资源**：引擎内置资源包 `internal` + 游戏资源包 `main`。
     *
     * 为什么要真加载而不是「延时凑进度」：两个资源包是分包，第一次用到才下载，
     * 而「第一次用到」的地方正是 Lobby —— 用户会看到大厅的 Label/Graphics
     * 一部分先出现、一部分后出现（闪一下）。在加载页把它们提前拉完，
     * 大厅首帧就是完整的，且进度条反映的是真实 IO。
     *
     * 失败不阻断：预加载只是优化，拉不到就让 Lobby 自己去加载（各自 bundle 内部
     * 已有加载逻辑），绝不能让优化手段变成新的卡死点。
     */
    private async _preload(): Promise<void> {
        const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T | null> =>
            new Promise<T | null>((resolve) => {
                let done = false;
                const timer = setTimeout(() => {
                    if (!done) {
                        done = true;
                        console.warn(`[LoadingScene] 预加载 ${what} 超时 ${ms}ms，跳过（交由业务自己加载）`);
                        resolve(null);
                    }
                }, ms);
                p.then((v) => {
                    if (!done) {
                        done = true;
                        clearTimeout(timer);
                        resolve(v);
                    }
                }).catch((err) => {
                    if (!done) {
                        done = true;
                        clearTimeout(timer);
                        console.warn(`[LoadingScene] 预加载 ${what} 失败（忽略）:`, err);
                        resolve(null);
                    }
                });
            });

        const names = ['internal', 'main'];
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            try {
                const bundle = assetManager.getBundle(name);
                if (!bundle) {
                    // 未随构建产出的包（例如被裁剪）→ 跳过，不算失败
                    continue;
                }
                // preload([]) 只拉资源清单与首帧资源（不解析），
                // 场景里正常 load() 时即可直接命中缓存。
                // 注意：AssetBundle.preload 是回调式 API，不是 Promise，
                // 这里手工包一层，超时兜底交给 withTimeout。
                await withTimeout(
                    new Promise<void>((resolve) => {
                        bundle.preload([], (err) => {
                            if (err) {
                                console.warn(`[LoadingScene] bundle:${name} 预加载返回错误（忽略）:`, err);
                            }
                            resolve();
                        });
                    }),
                    4000,
                    `bundle:${name}`,
                );
            } catch (err) {
                console.warn(`[LoadingScene] 预加载 bundle:${name} 异常（忽略）:`, err);
            }
            this._advance(STAGE_WEIGHT.RESOURCE * ((i + 1) / names.length));
        }
    }

    /**
     * 订阅版本更新状态，用于刷新本页的提示文案。
     *
     * **注册本身不在这里** —— `wx.getUpdateManager()` 的回调会长期存活，
     * 而 Loading 场景在 gotoLobby/gotoRoom 后就被销毁；若把注册写在场景组件里，
     * 更新就绪时（往往发生在用户切回前台之后）回调会往**已销毁的节点**写 Label。
     *
     * 因此注册与弹窗都在应用级（core/AppHooks.ts），本页只订阅状态显示提示，
     * 并在 onDestroy 里退订，不留悬空引用。
     */
    private _hookUpdateManager(): void {
        if (this._updateHooked) return;
        this._updateHooked = true;

        this._unsubscribeUpdate = onUpdateStateChange((state) => {
            switch (state) {
                case 'downloading':
                    this._setHint('发现新版本，正在下载…');
                    break;
                case 'ready':
                    this._setHint('新版本已就绪，即将重启更新');
                    break;
                case 'postponed':
                    // 用户选择「稍后再说」→ 收起提示
                    this._setHint(' ');
                    break;
                case 'failed':
                    this._setHint('更新失败，可继续游戏');
                    break;
                default:
                    // 'idle'：无更新信息，Hint 交由 _checkStuck 的兜底逻辑管理，
                    // 此处不写文案（否则会覆盖「加载较慢」提示）
                    break;
            }
        });
    }

    /**
     * 启动失败时给一个可点重试（避免用户卡在加载页无处可去）。
     *
     * 注意：这条路径现在**只服务于「真到了加载页且核心链路抛错」的极端情况**。
     * WxAuthService 已带三级兜底（不抛错），所以正常不会走到这里；
     * _degradeToLobby 才是登录失败的主路径（直接放行进大厅）。
     * 保留此方法是为了兜住「连降级本身都失败」的残余可能性，
     * 且重试是幂等的（_started 复位后重跑 _boot）。
     */
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
