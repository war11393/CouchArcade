/**
 * 应用启动引导。
 *
 * 负责：帧率设置、服务注入、（可选）云初始化。
 * 该组件挂在 Loading 场景的根节点上，是整个游戏的第一个执行点。
 *
 * 对应「默认参数基线」中的帧率=60 落实位置。
 */

import { _decorator, Component, game, Game, director } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { NetStatus } from './services/IServices';
import { services } from './ServiceLocator';
import { registerCloudHandlers } from '../stats/StatsService';

const { ccclass } = _decorator;

@ccclass('AppBootstrap')
export class AppBootstrap extends Component {
    private static _booted = false;

    protected onLoad(): void {
        if (AppBootstrap._booted) {
            console.log('[AppBootstrap] 已引导过，跳过重复初始化');
            return;
        }
        AppBootstrap._booted = true;

        // 1) 帧率 60（默认参数基线要求）
        game.frameRate = AppConfig.FRAME_RATE;
        // 保持常驻渲染（竖屏小游戏通常需要持续刷新 UI 计时器）
        game.pause = game.pause.bind(game);
        console.log(`[AppBootstrap] 帧率设置为 ${AppConfig.FRAME_RATE}`);

        // 2) 注入平台服务（依据 AppConfig.USE_MOCK 选择 Mock / Wx 实现）
        services.init();

        // 3) 云开发初始化（Mock 为内存 Map；Wx 为桩）
        services.cloud.init();

        // 4) 注册 Mock 云函数处理器（战绩写入等）
        registerCloudHandlers();

        // 5) 打印配置摘要，便于人工核对默认参数基线
        console.log('[AppBootstrap] 配置摘要:', JSON.stringify(AppConfig.describe(), null, 2));
        console.log(
            `[AppBootstrap] 运行模式：${AppConfig.USE_MOCK ? 'Mock（编辑器预览）' : '微信真机'}`,
        );

        // 6) 注册断线重连触发器（仅真机模式）
        //    必要性：watch 断线会自动重连但**只推增量**，必须触发一次全量对账，
        //    否则会丢断线期间的棋步（表现为「棋子缺失」）。
        this._hookReconnect();

        // 7) 持久化 director 引用，避免未使用导入被裁剪
        void director;
        void Game;
    }

    /**
     * 注册断线重连触发器。
     *
     * 两种触发时机（缺一不可）：
     *   · wx.onShow        —— 从后台切回前台（系统可能已断开长连接）
     *   · onNetworkStatusChange —— 网络从断开恢复
     *
     * 二者都调用 netSync.reconnect()，由它重建 watch 并派发 game.resync
     * 让业务层拉取全量状态对账。
     *
     * 仅在对局中（有 roomId 且已连接）才触发，避免无谓重连。
     */
    private _hookReconnect(): void {
        if (AppConfig.USE_MOCK) {
            // Mock 阶段无真实连接，重连逻辑由 MockNetSyncService 的
            // MOCK_RANDOM_DISCONNECT_RATE / 手动调用覆盖。
            console.log('[AppBootstrap] Mock 模式跳过断线重连触发器注册');
            return;
        }

        const tryReconnect = (reason: string): void => {
            const status = services.netSync.getStatus();
            const roomId = services.room.getCurrentRoomId();
            if (!roomId) {
                return;
            }
            if (status === NetStatus.CONNECTED || status === NetStatus.CONNECTING) {
                return;
            }
            console.log(`[AppBootstrap] 触发断线重连（reason=${reason}）`);
            void services.netSync.reconnect().catch((err: unknown) => {
                console.error('[AppBootstrap] 重连失败:', err);
            });
        };

        // 切回前台
        if (typeof services.platform.subscribeShow === 'function') {
            services.platform.subscribeShow(() => tryReconnect('onShow'));
        }

        // 网络恢复（经抽象层，业务代码不直接碰 wx.*）
        if (typeof services.platform.subscribeNetworkRestore === 'function') {
            services.platform.subscribeNetworkRestore(() => tryReconnect('network-restored'));
        }
    }
}
