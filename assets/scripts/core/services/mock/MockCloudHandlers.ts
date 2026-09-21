/**
 * Mock 云函数处理器安装器（仅 Mock 模式使用）。
 *
 * 目的：让「战绩写入」这条云函数调用链在第一阶段就跑通，
 * 第二阶段部署真实云函数后无需修改调用方代码（StatsService 的调用形态不变）。
 *
 * ============================================================================
 * 为什么单独成一个模块，而不是留在 StatsService 里
 * ============================================================================
 * 原实现把注册函数 `registerCloudHandlers()` 放在 `stats/StatsService.ts`，
 * 由 `AppBootstrap.onLoad()` 调用 —— 但 AppBootstrap **从未被挂到任何场景**
 * （见 core/AppBootstrap.ts 顶部说明），所以**注册从未发生过**：
 * 调用 MockCloudService.callFunction('settleGame') 只会拿到空对象。
 * 同时 `bindMockCloud()` 也没有任何调用方，导致即便注册了，
 * 处理器里的 `_mockCloudRef` 也是 null，战绩不会真正落库。
 *
 * 要修就得让注册发生在「保证执行」的路径上（ensureServices → ServiceLocator.init）。
 * 但 StatsService 反向 import 了 ServiceLocator，若 ServiceLocator 再 import
 * StatsService 就形成循环依赖 —— 本项目一贯用构造注入/延迟绑定规避环依赖
 * （参见 MockRoomService 在自己的构造函数里注册处理器、StatsService.bindMockCloud）。
 *
 * 因此把注册逻辑抽到本模块：它只依赖 MockCloudService 与 config 常量，
 * **不引用 ServiceLocator**，由 ServiceLocator 单向调用，无环。
 *
 * 顺带消除了 `bindMockCloud` 这一延迟绑定：处理器直接闭包捕获传入的实例，
 * 不再需要「先注册、再补绑实例」两步（少一个可漏做的步骤）。
 */

import { AppConfig } from '../../../config/AppConfig';
import { COLLECTIONS, CLOUD_FUNCTIONS } from '../../../config/Collections';
import { MockCloudService } from './MockCloudService';

/** 幂等标记：整个运行期只安装一次。 */
let _installed = false;

/**
 * 安装内置的 Mock 云函数处理器。
 *
 * @param cloud 当前的 MockCloudService 实例（用于让处理器直接读写内存集合）
 */
export function installMockCloudHandlers(cloud: MockCloudService): void {
    if (_installed) {
        return;
    }
    _installed = true;

    // ---- settleGame：模拟服务端把战绩写入 match_records ----
    // 真实实现见 cloudfunctions/settleGame（服务端以管理员权限写入）
    MockCloudService.registerHandler(CLOUD_FUNCTIONS.SETTLE_GAME, (data) => {
        void cloud.addDocument(COLLECTIONS.MATCH_RECORDS, data);
        console.log('[MockCloud] settleGame 处理器：战绩已落库');
        return `${COLLECTIONS.MATCH_RECORDS}_mock`;
    });

    // ---- login：模拟云函数返回 openid ----
    // 注意：Mock 模式下 MockAuthService 直接返回固定用户、不调用本函数，
    // 这里保留是为了「云函数调用链」的完整性（与真实链路同形）。
    MockCloudService.registerHandler(CLOUD_FUNCTIONS.LOGIN, () => {
        return { openid: AppConfig.MOCK_USER_OPENID, ok: true };
    });

    console.log(
        `[MockCloud] 云函数处理器安装完成（${CLOUD_FUNCTIONS.SETTLE_GAME} / ${CLOUD_FUNCTIONS.LOGIN}）`,
    );
}

/** 仅供调试/测试：查询是否已安装。 */
export function mockCloudHandlersInstalled(): boolean {
    return _installed;
}
