/**
 * Wx 登录鉴权服务桩 —— 第二阶段联通实现。
 *
 * 联通链路：wx.login() 拿 code → wx.cloud.callFunction('login', { code })
 *           → 云函数用 code2Session 换 openid → 返回 UserInfo
 *
 * TODO(wechat-phase2) 标记见各方法体。
 */

import { IAuthService, UserInfo } from '../IServices';

export class WxAuthService implements IAuthService {
    private _user: UserInfo | null = null;

    public async login(): Promise<UserInfo> {
        // TODO(wechat-phase2): 实现静默登录
        //   1. const { code } = await wx.login();            // 拿临时登录凭证
        //   2. const res = await wx.cloud.callFunction({
        //          name: 'login',
        //          data: { code },
        //      });
        //      // 云函数内部：cloud.getWXContext().OPENID 直接可得 openid，
        //      // 无需手动 code2Session（推荐做法），
        //      // 并在 cloudfunctions/login/index.js 中 upsert users 集合。
        //   3. this._user = { openid: res.result.openid, nickname, avatarUrl }
        //   注意：第一阶段不调用任何 wx API，此处保持空实现。
        //   验证方法：真机启动后控制台打印 openid，且 users 集合出现该用户文档。
        throw new Error('[WxAuthService] login() 未实现（第二阶段联通）');
    }

    public getCachedUser(): UserInfo | null {
        // TODO(wechat-phase2): 返回内存缓存；冷启动时可从 IStorageService 读取
        //   STORAGE_KEYS.USER_INFO 作为兜底（注意需与云端校验一致性）。
        return this._user;
    }

    public async updateProfile(nickname: string, avatarUrl: string): Promise<UserInfo> {
        // TODO(wechat-phase2): 接入 wx.getUserProfile({ desc: '用于完善会员资料' })
        //   注意：2022 年后该接口返回匿名数据（昵称=微信用户，头像=默认灰头像），
        //   如需真实昵称头像，建议改用 <button open-type="chooseAvatar"> 与
        //   <input type="nickname"> 组件（小游戏内需自绘 UI + wx.getUserInfo 替代方案）。
        //   验证方法：真机修改昵称后，users 集合同步更新。
        throw new Error('[WxAuthService] updateProfile() 未实现（第二阶段联通）');
    }
}
