/**
 * Mock 登录服务：返回固定测试用户，可配置昵称/头像。
 * 保证编辑器预览下「零配置即可进入游戏」。
 */

import { AppConfig } from '../../../config/AppConfig';
import { STORAGE_KEYS } from '../../../config/Collections';
import { IAuthService, IStorageService, UserInfo } from '../IServices';

export class MockAuthService implements IAuthService {
    private _user: UserInfo | null = null;
    private readonly _storage: IStorageService;

    constructor(storage: IStorageService) {
        this._storage = storage;
    }

    public async login(): Promise<UserInfo> {
        // 模拟网络往返，调用方可直接 await，无需关心延迟
        await this._delay(120);

        // 优先读取本地缓存（模拟「二次进入免登录」），否则用固定测试用户
        const cached = this._storage.get<UserInfo>(STORAGE_KEYS.USER_INFO);
        const user: UserInfo = cached ?? {
            openid: AppConfig.MOCK_USER_OPENID,
            nickname: AppConfig.MOCK_USER_NICKNAME,
            avatarUrl: AppConfig.MOCK_USER_AVATAR,
        };

        this._user = user;
        this._storage.set(STORAGE_KEYS.USER_INFO, user);
        console.log(`[MockAuth] 登录成功: ${user.nickname} (${user.openid})`);
        return user;
    }

    public getCachedUser(): UserInfo | null {
        if (!this._user) {
            this._user = this._storage.get<UserInfo>(STORAGE_KEYS.USER_INFO) ?? null;
        }
        return this._user;
    }

    public async updateProfile(nickname: string, avatarUrl: string): Promise<UserInfo> {
        await this._delay(80);
        const base = this.getCachedUser() ?? {
            openid: AppConfig.MOCK_USER_OPENID,
            nickname: AppConfig.MOCK_USER_NICKNAME,
            avatarUrl: AppConfig.MOCK_USER_AVATAR,
        };
        const user: UserInfo = { ...base, nickname, avatarUrl };
        this._user = user;
        this._storage.set(STORAGE_KEYS.USER_INFO, user);
        return user;
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
