/**
 * 应用级钩子注册 —— 模块作用域，生命周期与整个小游戏一致。
 *
 * ============================================================================
 * 为什么必须放在模块作用域，而不是某个场景组件里
 * ============================================================================
 *
 * 两个真实踩过的坑，都源于「把应用级监听写在了会被销毁的地方」：
 *
 * 1) **不能依赖 AppBootstrap**
 *    本项目场景由 `tools/ui-trees.js` 静态生成，而 `tools/gen-scenes.js` 的
 *    SCENES 表规定「每个场景根节点只挂一个控制器脚本」：
 *        { file: 'Loading', script: 'LoadingScene', ... }
 *    `AppBootstrap` 不在该表中，**从未被挂到任何场景**，
 *    因此它的 onLoad 永不执行 —— 写在里面的注册全是死代码。
 *    （运行时日志会出现 `ensureServices：运行时兜底注入（AppBootstrap 未执行）`，
 *      即 ServiceLocator 早已预判到这一点并做了兜底。）
 *
 * 2) **不能放在 LoadingScene**
 *    Loading 场景在 gotoLobby/gotoRoom 后会被销毁，其 onDestroy 里注销的监听
 *    随之失效。而「切回前台」「网络恢复」「再次点击分享卡片」都是**贯穿全程**
 *    的能力，必须在切场景后依然有效。
 *
 * 结论：这里用模块级函数 + 幂等标记注册，由 `ensureServices()` 调用
 * （该函数被每个场景的 onLoad 首先调用，是项目约定的「保证执行」入口）。
 *
 * 依赖注入说明：服务容器通过参数传入而非 import，避免
 * `ServiceLocator → AppHooks → ServiceLocator` 循环依赖
 * （本项目一贯用构造注入规避环依赖，此处保持一致）。
 */

import { AiLevel } from '../config/AppConfig';
import { GameId } from '../config/GameList';
import { uiManager } from './UIManager';
import { NetStatus } from './services/IServices';
import type { ServiceContainer } from './ServiceLocator';
import type { LaunchOptions } from './services/IServices';

/** 必须与游戏清单一致（见 config/GameList.ts）。 */
const VALID_GAME_IDS: readonly string[] = [GameId.PLANE_HUNT, GameId.GOMOKU];

/** 幂等标记：整个运行期只注册一次。 */
let _registered = false;
/** 注入的服务容器（registerAppHooks 时赋值）。 */
let _svc: ServiceContainer | null = null;

/**
 * 解析启动参数里的「直进房间」意图。
 *
 * 冷启动（Loading 阶段读 getLaunchOptions）与热启动（onShow 回调）
 * 共用这一份解析与校验，避免两处规则漂移。
 *
 * @returns 合法时返回目标，否则返回 null（并打日志说明原因）
 */
export function parseRoomLaunchQuery(
    query: Record<string, string>,
): { roomId: string; gameId: GameId } | null {
    const roomId = query['roomId'];
    const gameId = query['gameId'];

    if (!roomId || !gameId) {
        return null;
    }
    // query 里所有值都是字符串（微信约定），roomId 由服务端生成为 6 位数字
    if (!/^\d{6}$/.test(roomId)) {
        console.warn(`[AppHooks] 启动参数 roomId 非法（应为 6 位数字）：${roomId}`);
        return null;
    }
    if (!VALID_GAME_IDS.includes(gameId)) {
        console.warn(`[AppHooks] 启动参数 gameId 非法（不在游戏清单中）：${gameId}`);
        return null;
    }

    return { roomId, gameId: gameId as GameId };
}

/**
 * 触发对局断线重连（含全量对账）。
 *
 * 必要性：watch 断线会自动重连但**只推增量**，不触发一次全量对账
 * 就会丢掉断线期间的棋步（表现为「棋子缺失」）。
 */
export function tryReconnect(reason: string): void {
    const svc = _svc;
    if (!svc) {
        return;
    }

    const roomId = svc.room.getCurrentRoomId();
    if (!roomId) {
        return; // 不在房间，无需重连
    }

    const status = svc.netSync.getStatus();
    if (status === NetStatus.CONNECTED || status === NetStatus.CONNECTING) {
        return; // 连接正常，无需重连
    }

    console.log(`[AppHooks] 触发断线重连（reason=${reason} status=${status}）`);
    void svc.netSync.reconnect().catch((err: unknown) => {
        console.error('[AppHooks] 重连失败:', err);
    });
}

/**
 * 处理热启动（App 从后台切回前台 / 点击新的分享卡片）。
 *
 * 为什么必须做：`wx.getLaunchOptionsSync()` 只在**冷启动**时反映参数。
 * App 已在后台时，用户点击另一张分享卡片不会更新它 ——
 * 这是「分享直达房间」最常见的线上问题（点了卡片却停在大厅）。
 */
function handleHotStart(options: LaunchOptions): void {
    const svc = _svc;

    // 1) 先尝试重连（切回前台时系统可能已断开长连接）
    tryReconnect('onShow');

    // 2) 再看是否要切到卡片指定的房间
    const target = parseRoomLaunchQuery(options.query);
    if (!target) {
        return; // 只是切回前台，保持当前界面不动
    }

    const currentRoom = svc ? svc.room.getCurrentRoomId() : null;
    if (currentRoom === target.roomId) {
        console.log(`[AppHooks] 热启动指向当前房间 ${target.roomId}，无需切换`);
        return;
    }

    console.log(
        `[AppHooks] 热启动检测到分享直达：roomId=${target.roomId} gameId=${target.gameId}` +
            `（当前房间=${currentRoom ?? '无'}）`,
    );
    uiManager.gotoRoom({
        gameId: target.gameId,
        mode: 'pvp',
        aiLevel: AiLevel.NORMAL,
        joinRoomId: target.roomId,
    });
}

/**
 * 注册应用级钩子（幂等）。
 *
 * 由 `ensureServices()` 调用 —— 该函数保证在任意场景的 onLoad 首先执行，
 * 因此这里的注册不受「某个组件是否恰好挂上场景」影响。
 *
 * @param svc 服务容器（由 ServiceLocator 传入，避免循环依赖）
 */
export function registerAppHooks(svc: ServiceContainer): void {
    if (_registered) {
        return;
    }
    _registered = true;
    _svc = svc;

    const platform = svc.platform;

    // ---- 热启动：切回前台 + 新分享卡片 ----
    if (typeof platform.subscribeShow === 'function') {
        platform.subscribeShow(handleHotStart);
        console.log('[AppHooks] 已注册热启动监听（onShow）');
    } else {
        console.warn('[AppHooks] 平台服务未实现 subscribeShow，热启动分享直达不可用');
    }

    // ---- 网络恢复：断网重连 ----
    if (typeof platform.subscribeNetworkRestore === 'function') {
        platform.subscribeNetworkRestore(() => tryReconnect('network-restored'));
        console.log('[AppHooks] 已注册网络恢复监听');
    }
}

/** 仅供调试/测试：查询是否已注册。 */
export function appHooksRegistered(): boolean {
    return _registered;
}
