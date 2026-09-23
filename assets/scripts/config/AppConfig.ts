/** AI 难度枚举，供房间创建与 AI 工厂统一使用。 */
export enum AiLevel {
    EASY = 1,
    NORMAL = 2,
    HARD = 3,
}

/**
 * 全局可配置项集中管理。
 *
 * 阶段边界：本文件是「Mock ↔ 真实微信实现」的唯一切换入口。
 * 第二阶段人工操作：把 USE_MOCK 置为 false 即可全局切换到 wx 实现，
 * 业务层无需任何改动（业务层只依赖 core/services 下的接口）。
 */
export class AppConfig {
    // ==================== 总开关 ====================

    /**
     * true  = 使用 Mock 实现（编辑器预览/浏览器可全流程可玩，零 wx 依赖）
     * false = 使用 Wx 实现（微信真机联调）
     *
     * ⚠️ 第二阶段已切换到 false。
     * 若需回到编辑器内调试（不依赖微信环境），把此处改回 true 并重新构建/预览即可，
     * 业务层零改动 —— 这正是本开关存在的意义。
     */
    public static USE_MOCK = false;

    // ==================== 微信侧配置 ====================

    /** 微信小游戏 appid。第二阶段已填入真实值（与 build-templates / builder.json 保持一致）。 */
    public static readonly WX_APPID = 'wxd5cc731e7273d122';

    /** 云开发环境 ID。第二阶段已填入真实值。 */
    public static readonly CLOUD_ENV = 'cloud1-d7gp1em2efcf2b05b';

    /** 云函数所在地域占位（部分环境需要）。 */
    public static readonly CLOUD_REGION = 'ap-shanghai';

    /** 远程资源服务器地址占位（CDN / 分包远程包）。 */
    public static readonly REMOTE_SERVER = 'https://TODO.example.com/remote';

    /** 首包体积预算（字节），用于体积守卫日志告警。 */
    public static readonly FIRST_PACKAGE_BUDGET_BYTES = 4 * 1024 * 1024;

    // ==================== 设计分辨率与适配（与 settings/v2/packages/project.json 保持一致） ====================

    /**
     * 客户端版本号（唯一来源）。
     *
     * 用于 Loading 页展示与版本更新提示。发版时改这里
     * （微信小游戏自身的版本号由平台管理，两者不必一致，但建议同步）。
     */
    public static readonly APP_VERSION = '0.1.1';

    /**
     * 设计分辨率**基准**：竖屏主流机型 720 × 1280。
     *
     * ⚠️ 竖版自适应（core/PortraitAdapter.ts）落地后，这里的语义是：
     *   · DESIGN_WIDTH  = 宽度基准，**运行期保持生效**（FIXED_WIDTH 横向撑满，
     *     所有内容宽度按 720 书写）；
     *   · DESIGN_HEIGHT = 参考高度，**运行期会被按机型重算**
     *     （designH = 720 × 屏幕高/宽）。它只用于编辑器预览、
     *     校验脚本的参考几何，以及拿不到屏幕尺寸时的兜底。
     *   想知道当前机型真实的设计高，用 portraitAdapter.layout.designH。
     */
    public static readonly DESIGN_WIDTH = 720;
    public static readonly DESIGN_HEIGHT = 1280;

    /**
     * 适配策略：FIXED_WIDTH（拟合宽度）。
     * settings/v2/packages/project.json 的 fitWidth=true 是**启动初值**；
     * PortraitAdapter.apply() 在每个场景 onLoad 时以同样的策略重算设计高，
     * 两者必须保持一致，否则首帧与第二帧之间会出现一次可见的缩放跳变。
     */
    public static readonly DESIGN_FIT_WIDTH = true;
    public static readonly DESIGN_FIT_HEIGHT = false;

    /** 目标帧率 60。在 LoadingScene.onLoad 中通过 game.frameRate = 60 落实。 */
    public static readonly FRAME_RATE = 60;

    // ==================== 交互基线与 UI ====================

    /** 最小可点击热区（pt），微信小游戏规范建议 ≥ 44。 */
    public static readonly MIN_TOUCH_SIZE = 44;

    /** 安全区兜底值（px）：Mock 模拟刘海屏时的默认避让高度。 */
    public static readonly SAFE_AREA_FALLBACK_TOP = 44;
    public static readonly SAFE_AREA_FALLBACK_BOTTOM = 34;

    // ==================== 对局参数 ====================

    /** 每步限时（秒）。超时由服务器/Mock 房间广播强制跳过或判负。 */
    public static readonly TURN_TIME_LIMIT_SEC = 30;

    /** 每步限时告警阈值（秒），剩余低于此值时计时器变红。 */
    public static readonly TURN_TIME_WARN_SEC = 10;

    /** AI 难度默认值，可被房间设置覆盖。使用数字字面量避免 TS2450 枚举前向引用。 */
    public static readonly DEFAULT_AI_LEVEL = 2 as AiLevel;

    /** AI 思考延迟区间（毫秒），模拟真实对手的「思考」表现。 */
    public static readonly AI_THINK_MIN_MS = 500;
    public static readonly AI_THINK_MAX_MS = 1500;

    /** 五子棋 AI 思考区间（毫秒），规格要求 0.8~2s。 */
    public static readonly GOMOKU_AI_THINK_MIN_MS = 800;
    public static readonly GOMOKU_AI_THINK_MAX_MS = 2000;

    /** 寻机头 AI 思考区间（毫秒），规格要求 0.5~1.5s。 */
    public static readonly PLANEHUNT_AI_THINK_MIN_MS = 500;
    public static readonly PLANEHUNT_AI_THINK_MAX_MS = 1500;

    /** 寻机头棋盘尺寸 12×12。 */
    public static readonly PLANEHUNT_SIZE = 12;
    /** 寻机头飞机数量。 */
    public static readonly PLANEHUNT_PLANE_COUNT = 5;

    /** 五子棋棋盘尺寸 15×15，先连五者胜。 */
    public static readonly GOMOKU_SIZE = 15;
    /** 五子棋连胜数。 */
    public static readonly GOMOKU_WIN_COUNT = 5;

    /** 投降/退出对局是否判负。 */
    public static readonly SURRENDER_IS_LOSE = true;

    // ==================== Mock 行为参数（保证编辑器内体验逼近真实联机） ====================

    /** Mock 网络延迟区间（毫秒），规格要求 80~200ms。 */
    public static readonly MOCK_LATENCY_MIN_MS = 80;
    public static readonly MOCK_LATENCY_MAX_MS = 200;

    /** Mock 对手入座延迟区间（毫秒），规格要求 1~3 秒。 */
    public static readonly MOCK_OPPONENT_JOIN_MIN_MS = 1000;
    public static readonly MOCK_OPPONENT_JOIN_MAX_MS = 3000;

    /** Mock 对手「准备」延迟（毫秒）。 */
    public static readonly MOCK_OPPONENT_READY_MIN_MS = 500;
    public static readonly MOCK_OPPONENT_READY_MAX_MS = 1500;

    /** Mock 房间超时解散时间（毫秒），超时未开局自动解散。 */
    public static readonly MOCK_ROOM_TIMEOUT_MS = 120000;

    /** Mock 断线重连模拟：随机断线概率（0 表示不模拟，便于稳定自测）。 */
    public static readonly MOCK_RANDOM_DISCONNECT_RATE = 0;

    /** Mock 登录固定测试用户（可配置昵称/头像）。 */
    public static readonly MOCK_USER_OPENID = 'mock-openid-0001';
    public static readonly MOCK_USER_NICKNAME = '测试玩家';
    public static readonly MOCK_USER_AVATAR = '';

    /** Mock 对手昵称池，房间内随机取用。 */
    public static readonly MOCK_OPPONENT_NICKNAMES: readonly string[] = [
        '机头猎手',
        '五子小王子',
        '摸鱼达人',
        '路人甲',
        '深夜棋手',
    ];

    /** 大厅在线人数模拟区间（Mock 用，真实阶段由云函数返回）。 */
    public static readonly MOCK_ONLINE_MIN = 120;
    public static readonly MOCK_ONLINE_MAX = 4200;

    // ==================== 调试开关 ====================

    /** 详细日志（事件总线空监听、同步报文等）。 */
    public static LOG_VERBOSE = true;

    /** 显示运行时调试信息（FPS/网络延迟/RoomId）。 */
    public static SHOW_DEBUG_HUD = false;

    /**
     * 弹窗定位诊断（临时开关）。
     *
     * true 时，模式选择弹窗会把运行时真实状态（父节点/尺寸/缩放/透明/兄弟序号/
     * 节点 layer 与相机可见性）直接画在屏幕上，用于定位「弹窗不显示」这类
     * 只能靠眼看的问题。定位完请改回 false —— 它只是排查工具，不是功能。
     *
     * 历史：这个面板两次都精准定位了真因（第 4 轮 Overlay 缺 UITransform、
     * 第 6 轮运行时节点在 DEFAULT 层），需要再查「看得见/点得到」类问题时先打开它。
     */
    public static SHOW_DIALOG_DEBUG = false;

    /** 是否启用「开发者跳过」：AI 练习模式直接进入，无需等待。 */
    public static readonly DEV_SKIP_AI_WAIT = false;

    /**
     * 体积/配置守卫：在 Loading 阶段打印当前阶段配置摘要，
     * 便于人工核对「默认参数基线落实清单」。
     */
    public static describe(): Record<string, string | number | boolean> {
        return {
            USE_MOCK: AppConfig.USE_MOCK,
            WX_APPID: AppConfig.WX_APPID,
            CLOUD_ENV: AppConfig.CLOUD_ENV,
            DESIGN: `${AppConfig.DESIGN_WIDTH}x${AppConfig.DESIGN_HEIGHT}`,
            FIT_WIDTH: AppConfig.DESIGN_FIT_WIDTH,
            FRAME_RATE: AppConfig.FRAME_RATE,
            TURN_LIMIT: AppConfig.TURN_TIME_LIMIT_SEC,
            AI_LEVEL: AppConfig.DEFAULT_AI_LEVEL,
            MOCK_LATENCY: `${AppConfig.MOCK_LATENCY_MIN_MS}~${AppConfig.MOCK_LATENCY_MAX_MS}ms`,
            FIRST_PKG_BUDGET: AppConfig.FIRST_PACKAGE_BUDGET_BYTES,
        };
    }
}
