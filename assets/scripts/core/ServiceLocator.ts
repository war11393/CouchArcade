/**
 * 服务定位器：依据 AppConfig.USE_MOCK 统一注入 Mock / Wx 两套实现。
 *
 * 使用方式（业务层只认接口，不认实现）：
 *   import { services } from '../core/ServiceLocator';
 *   const info = services.platform.getSystemInfo();
 *   const user = await services.auth.login();
 *
 * 切换方式：修改 AppConfig.USE_MOCK 即可，业务层零改动。
 */

import { AppConfig } from '../config/AppConfig';
import {
    IAuthService,
    ICloudService,
    INetSyncService,
    IPlatformService,
    IRoomService,
    IShareService,
    IStorageService,
} from './services/IServices';

// ---------- Mock 实现 ----------
import { MockAuthService } from './services/mock/MockAuthService';
import { MockCloudService } from './services/mock/MockCloudService';
import { MockNetSyncService } from './services/mock/MockNetSyncService';
import { MockPlatformService } from './services/mock/MockPlatformService';
import { MockRoomService } from './services/mock/MockRoomService';
import { MockShareService } from './services/mock/MockShareService';
import { MockStorageService } from './services/mock/MockStorageService';

// ---------- Wx 桩实现（第二阶段联通） ----------
import { WxAuthService } from './services/wx/WxAuthService';
import { WxCloudService } from './services/wx/WxCloudService';
import { WxNetSyncService } from './services/wx/WxNetSyncService';
import { WxPlatformService } from './services/wx/WxPlatformService';
import { WxRoomService } from './services/wx/WxRoomService';
import { WxShareService } from './services/wx/WxShareService';
import { WxStorageService } from './services/wx/WxStorageService';

/** 服务集合的类型描述，供 IDE 补全。 */
export interface ServiceContainer {
    platform: IPlatformService;
    auth: IAuthService;
    room: IRoomService;
    netSync: INetSyncService;
    share: IShareService;
    storage: IStorageService;
    cloud: ICloudService;
}

/**
 * 全局服务容器。
 *
 * 注意：netSync 是「对局内」服务，Mock 实现内部持有房间/AI 引用，
 * 由 MockRoomService 在对局开始时装配对手 AI。真实阶段由云函数驱动。
 */
class ServiceLocatorImpl implements ServiceContainer {
    private _platform!: IPlatformService;
    private _auth!: IAuthService;
    private _room!: IRoomService;
    private _netSync!: INetSyncService;
    private _share!: IShareService;
    private _storage!: IStorageService;
    private _cloud!: ICloudService;
    private _inited = false;

    public get platform(): IPlatformService {
        return this._platform;
    }
    public get auth(): IAuthService {
        return this._auth;
    }
    public get room(): IRoomService {
        return this._room;
    }
    public get netSync(): INetSyncService {
        return this._netSync;
    }
    public get share(): IShareService {
        return this._share;
    }
    public get storage(): IStorageService {
        return this._storage;
    }
    public get cloud(): ICloudService {
        return this._cloud;
    }

    /**
     * 注入全部实现。App.onLoad 中调用一次。
     * 幂等：重复调用会直接返回，避免热重载重复注入。
     */
    public init(): void {
        if (this._inited) {
            console.warn('[ServiceLocator] 已初始化，跳过重复注入');
            return;
        }

        if (AppConfig.USE_MOCK) {
            console.log('[ServiceLocator] 注入 Mock 实现（编辑器预览模式）');
            this._storage = new MockStorageService();
            this._platform = new MockPlatformService();
            this._auth = new MockAuthService(this._storage);
            this._cloud = new MockCloudService();
            this._share = new MockShareService();
            this._netSync = new MockNetSyncService();
            this._room = new MockRoomService(this._auth, this._cloud, this._netSync);
        } else {
            console.log('[ServiceLocator] 注入 Wx 实现（真机模式）');
            this._storage = new WxStorageService();
            this._platform = new WxPlatformService();
            this._auth = new WxAuthService();
            this._cloud = new WxCloudService();
            this._share = new WxShareService();
            this._netSync = new WxNetSyncService();
            this._room = new WxRoomService();
        }

        this._inited = true;

        // 暴露到全局，便于浏览器控制台手动调试（仅 Mock 阶段）
        if (AppConfig.USE_MOCK && AppConfig.LOG_VERBOSE) {
            (globalThis as Record<string, unknown>).__services = this;
            (globalThis as Record<string, unknown>).__appConfig = AppConfig;
        }
    }

    /**
     * 绑定对局内的 AI 对手（仅 Mock 使用）。
     *
     * 设计意图：Mock 联机 = 通过同步协议通道与 AI 对打。
     * 真实阶段此调用是空实现/不调用，对手操作由服务器下发。
     */
    public bindMockOpponent(roomId: string, opponentPlayerId: string): void {
        if (!AppConfig.USE_MOCK) {
            return;
        }
        const svc = this._netSync as MockNetSyncService;
        if (typeof svc.bindOpponent === 'function') {
            svc.bindOpponent(roomId, opponentPlayerId);
        }
    }

    /** 解绑 Mock 对手（离开房间/对局结束时调用）。 */
    public unbindMockOpponent(): void {
        if (!AppConfig.USE_MOCK) {
            return;
        }
        const svc = this._netSync as MockNetSyncService;
        if (typeof svc.unbindOpponent === 'function') {
            svc.unbindOpponent();
        }
    }

    /** 重置（重登/切账号时使用，仅供调试）。 */
    public reset(): void {
        this._inited = false;
    }

    /** 是否已注入实现。 */
    public get inited(): boolean {
        return this._inited;
    }
}

export const services = new ServiceLocatorImpl();

/**
 * 确保服务已注入（幂等）。**任何场景的控制组件在 onLoad 里应首先调用它。**
 *
 * 背景：服务注入原本设计由 AppBootstrap 组件完成，但组件是否被挂到场景是易错点；
 * 一旦漏挂，各服务 getter 全返回 undefined，表现为
 * `Cannot read properties of undefined (reading 'getSystemInfo')` 之类的运行时崩溃。
 * 统一走这个兜底入口，可让场景不再依赖「某个组件恰好挂在某个场景上」这一隐含约定。
 *
 * 注意：AppBootstrap 仍负责帧率、云初始化、云函数注册等一次性引导；
 * 本函数只保证 ServiceLocator 可用。
 */
export function ensureServices(): void {
    if (!services.inited) {
        console.log('[ServiceLocator] ensureServices：运行时兜底注入（AppBootstrap 未执行）');
        services.init();
    }
    // cloud.init() 也是幂等的（Mock 为内存 Map），确保云服务可用
    services.cloud.init();
}
