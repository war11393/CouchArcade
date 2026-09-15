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

        // 6) 持久化 director 引用，避免未使用导入被裁剪
        void director;
        void Game;
    }
}
