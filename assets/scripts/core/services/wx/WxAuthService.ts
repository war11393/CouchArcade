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

/** 本地会话的 id 前缀 —— 一眼能认出「这不是云端下发的真 openid」。 */
const LOCAL_ID_PREFIX = 'local_';

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
     * 兜底策略（**本方法不抛错**，三级递进）：
     *   ① 云函数失败但缓存里有云端 openid → 用缓存（网络抖动不影响开局）；
     *   ② 缓存也没有 / 缓存本身就是本地会话 → 造本地会话（`local_` 前缀）；
     *   ③ 上一轮已降级的本地会话 → 直接复用，不再等一次必失败的云调用。
     *
     * 唯一目的是：**登录失败绝不能让用户卡死在加载页**。云端登录挂了，
     * 用户至少要能进大厅玩单机（AI 练习）；联机功能失败会在各自调用处报错。
     * 每次降级都会打 warn 日志，便于排查服务端配置问题。
     */
    public async login(): Promise<UserInfo> {
        const cached = this._storage.get<UserInfo>(STORAGE_KEYS.USER_INFO) ?? null;

        // 上一轮已经降级过 → 直接用本地会话，不再重试云函数
        // （否则每次冷启动都要等一次必失败的云调用，白白拖慢启动）
        if (cached && cached.openid && this._isLocalId(cached.openid)) {
            this._user = cached;
            console.log(`[WxAuth] 沿用本地会话 id=${cached.openid}（云端登录此前未成功）`);
            return cached;
        }

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

            // 兜底 1：缓存里有「云端下发的」openid（老版本缓存）→ 继续用
            if (cached && cached.openid && !this._isLocalId(cached.openid)) {
                this._user = cached;
                console.log(`[WxAuth] 使用缓存用户 openid=${cached.openid}（云端校验未通过）`);
                return cached;
            }

            // 兜底 2：缓存不可用 → 造本地会话。
            //
            // 为什么必须有这一层：云函数失败的原因绝大多数在服务端配置
            // （未部署 / 未选环境 / 权限），客户端重试多少次都一样。若这里抛错，
            // 唯一的结果是用户**永远卡在加载页**，而且连大厅都看不到 —— 一个
            // 「登录挂了」不应该等于「整个小游戏打不开」。
            // 单人模式（AI 练习）根本不依赖服务端，必须能玩。
            const local = await this._createLocalUser(cached, nickname, avatarUrl);
            console.warn(
                `[WxAuth] 云端登录不可用，已降级为本地会话 id=${local.openid}；` +
                    '联机功能（建房/匹配/云战绩）将不可用，请修复云函数后重启小游戏',
            );
            return local;
        }
    }

    /** 是否为本地生成的会话 id（非云端 openid）。 */
    private _isLocalId(id: string): boolean {
        return id.startsWith(LOCAL_ID_PREFIX);
    }

    /**
     * 生成本地会话，并写回缓存（下次冷启动直接复用，避免再等一次必失败的云调用）。
     *
     * id 生成：用 wx.login 的 code 派生 —— code 是小游戏端唯一稳定可得的设备身份凭据，
     * 同一设备每次冷启动拿到的是同一份身份，因此本地会话 id 在设备内保持稳定
     * （Mock 缓存、房间列表等按 openid 归集的逻辑不会每次启动都「换个人」）。
     * 取不到 code 时退化为随机 id：宁可换身份，也不要卡在加载页。
     *
     * ⚠️ 本地 id **不是**可信身份：不能用于联机对局（服务端 openid 校验必然不通过），
     * 只用于让单机流程可跑。带 `local_` 前缀，便于日志与题库排查时一眼辨认。
     */
    private async _createLocalUser(
        cached: UserInfo | null,
        nickname: string | undefined,
        avatarUrl: string | undefined,
    ): Promise<UserInfo> {
        const seed = (await this._getLoginCode()) ?? `${Date.now()}_${Math.random()}`;
        const user: UserInfo = {
            openid: `${LOCAL_ID_PREFIX}${this._hash(seed)}`,
            nickname: nickname || cached?.nickname || '游客',
            avatarUrl: avatarUrl || cached?.avatarUrl || '',
        };
        this._user = user;
        this._storage.set(STORAGE_KEYS.USER_INFO, user);
        return user;
    }

    /** 取 wx.login 的 code（失败返回 null，由调用方退化处理）。 */
    private async _getLoginCode(): Promise<string | null> {
        try {
            if (typeof wx === 'undefined' || typeof wx.login !== 'function') {
                return null;
            }
            const res = await new Promise<WxLoginResult>((resolve) => {
                wx.login({
                    success: (r) => resolve(r),
                    fail: () => resolve({}),
                });
            });
            return res && res.code ? res.code : null;
        } catch (err) {
            console.warn('[WxAuth] wx.login 失败（本地会话将使用随机 id）:', err);
            return null;
        }
    }

    /**
     * 稳定短哈希（FNV-1a 32 位 → 8 位十六进制）。
     *
     * 只用于生成可读的本地 id，**不用于任何安全用途**（不做签名/校验）。
     */
    private _hash(input: string): string {
        let h = 0x811c9dc5;
        for (let i = 0; i < input.length; i++) {
            h ^= input.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return (h >>> 0).toString(16).padStart(8, '0');
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
