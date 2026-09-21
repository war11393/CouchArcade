/**
 * 应用启动引导（组件）。
 *
 * ⚠️⚠️ 重要现状：**本组件的 onLoad 目前不会执行。**
 *
 * 原因：本项目场景由 `tools/ui-trees.js` 静态生成，而 `tools/gen-scenes.js`
 * 的 SCENES 表规定「每个场景根节点只挂一个控制器脚本」：
 *     { file: 'Loading', script: 'LoadingScene', tree: loadingTree }
 *     { file: 'Lobby',   script: 'LobbyScene',   tree: lobbyTree }
 * `AppBootstrap` 不在该表中，因此从未被挂到任何场景上。
 * 运行时日志可以印证：`[ServiceLocator] ensureServices：运行时兜底注入（AppBootstrap 未执行）`。
 *
 * 由此得出的铁律：
 * **任何「必须执行」的初始化逻辑都不能写在本文件里** —— 那是死代码。
 * 现有初始化已全部落在保证执行的路径上：
 *   · 服务注入 / 云初始化  → ServiceLocator.ensureServices()（每个场景 onLoad 首先调用）
 *   · 帧率                 → LoadingScene._applyFrameRate()
 *   · 应用级钩子（热启动 / 网络恢复 / 断线重连）→ core/AppHooks.ts，由 ensureServices() 注册
 *
 * 本文件暂时保留作为「原始引导逻辑」的参考实现，不参与运行。
 * 如需真正启用，须在 tools/ui-trees.js + gen-scenes.js 中把它挂到 Loading 场景根节点
 * （注意：当前场景构建器每个根节点只支持一个脚本组件，需先扩展）。
 */

import { _decorator, Component, game, Game, director } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { services } from './ServiceLocator';

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

        // 3) 云开发初始化（Mock 为内存 Map；Wx 为 wx.cloud.init）
        services.cloud.init();

        // 4) Mock 云函数处理器（战绩写入等）
        //    已迁至 core/services/mock/MockCloudHandlers.ts，
        //    由 ServiceLocator.init() 在注入 Mock 实现时调用（保证执行）。
        //    原先写在这里的 registerCloudHandlers() 因本组件未挂载而从未执行。

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
