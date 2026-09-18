/**
 * Wx 登录鉴权服务 —— 第二阶段真实实现。
 *
 * 联通链路：wx.cloud.callFunction('login') → 云函数内 cloud.getWXContext().OPENID
 *           → 返回 UserInfo
 *
 * 关键设计：**不需要** wx.login 拿 code 再 code2Session ——
 * 云开发在云函数内直接注入 OPENID，无法伪造，这是小游戏云开发的标准做法。
 * （原始桩文件的注释里写了 code2Session，那是冗余路径，本实现不采用。）
 */

import { STORAGE_KEYS } from '../../../config/Collections';
import { CloudError, errText } from '../../../config/CloudErrors';
import { IAuthService, ICloudService, IStorageService, UserInfo } from '../IServices';

/** 云函数 login 的返回 data 结构（见 cloudfunctions/login/index.js）。 */
interface LoginResult {
    openid: string;
    nickname: string;
    avatarUrl: string;
    winCount?: number;
    loseCount?: number;
    drawCount?: number;
}

export class WxAuthService implements IAuthService {
    private _user: UserInfo | null = null;
    private readonly _cloud: ICloudService;
    private readonly _storage: IStorageService;

    constructor(cloud: ICloudService, storage: IStorageService) {
        this._cloud = cloud;
        this._storage = storage;
    }

    /**
     * 静默登录。
     *
     * 流程：
     *   1. 读本地缓存（STORAGE_KEYS.USER_INFO）作为「秒开」兜底；
     *   2. 调云函数 login 换取权威 openid（服务端 upsert users 集合）；
     *   3. 回写缓存。
     *
     * 兜底策略：云函数失败时**不抛错**，而是回落到缓存用户；
     * 缓存也没有才抛出 —— 保证「网络抖动」不会直接卡死在 Loading。
     * 但会打 warn 日志，便于排查。
     */
    public async login(): Promise<UserInfo> {
        const cached = this._storage.get<UserInfo>(STORAGE_KEYS.USER_INFO) ?? null;

        // 昵称/头像：优先用缓存里的（第二阶段若做了昵称填写能力，这里会带上）
        const nickname = cached?.nickname;
        const avatarUrl = cached?.avatarUrl;

        try {
            const data = await this._cloud.callFunction<
                { nickname?: string; avatarUrl?: string },
                LoginResult
            >('login', { nickname, avatarUrl });

            if (!data || !data.openid) {
                throw new CloudError(9003, '[WxAuth] login 返回缺少 openid');
            }

            const user: UserInfo = {
                openid: data.openid,
                nickname: data.nickname || cached?.nickname || '微信用户',
                avatarUrl: data.avatarUrl || cached?.avatarUrl || '',
            };

            this._user = user;
            this._storage.set(STORAGE_KEYS.USER_INFO, user);
            console.log(`[WxAuth] 登录成功 openid=${user.openid} nickname=${user.nickname}`);
            return user;
        } catch (err) {
            const code = err instanceof CloudError ? err.code : 9999;
            console.warn(
                `[WxAuth] login 云函数失败（code=${code} ${errText(code)}），尝试使用本地缓存兜底`,
                err,
            );

            // 兜底：缓存存在则继续用（离线可玩大厅，但联机功能会失败）
            if (cached && cached.openid) {
                this._user = cached;
                console.log(`[WxAuth] 使用缓存用户 openid=${cached.openid}（云端校验未通过）`);
                return cached;
            }

            // 缓存也没有 → 无法继续，抛给上层（Loading 页展示错误）
            throw err instanceof CloudError
                ? err
                : new CloudError(9999, `[WxAuth] 登录失败: ${String(err)}`);
        }
    }

    public getCachedUser(): UserInfo | null {
        if (!this._user) {
            // 冷启动首次访问：从存储补读
            this._user = this._storage.get<UserInfo>(STORAGE_KEYS.USER_INFO) ?? null;
        }
        return this._user;
    }

    /**
     * 更新昵称/头像。
     *
     * 说明：wx.getUserProfile 自 2022-10-25 起在新注册小程序中返回匿名数据
     * （昵称恒为「微信用户」、头像为默认灰头像），因此本方法**不调用它**，
     * 而是把调用方（自绘昵称输入 UI / chooseAvatar 能力）收集到的值
     * 直接透传云函数 login 落库。
     *
     * 头像注意事项：微信返回的 avatarUrl 是临时链接（约 3 天有效期），
     * 如需长期有效应下载后上传云存储换永久 fileID，本项目暂存原值。
     */
    public async updateProfile(nickname: string, avatarUrl: string): Promise<UserInfo> {
        const base = this.getCachedUser();
        if (!base) {
            throw new CloudError(4009, '[WxAuth] 尚未登录，无法更新资料');
        }

        const data = await this._cloud.callFunction<
            { nickname?: string; avatarUrl?: string },
            LoginResult
        >('login', { nickname, avatarUrl });

        const user: UserInfo = {
            openid: (data && data.openid) || base.openid,
            nickname: (data && data.nickname) || nickname,
            avatarUrl: (data && data.avatarUrl) || avatarUrl,
        };

        this._user = user;
        this._storage.set(STORAGE_KEYS.USER_INFO, user);
        console.log(`[WxAuth] 资料已更新 nickname=${user.nickname}`);
        return user;
    }
}
