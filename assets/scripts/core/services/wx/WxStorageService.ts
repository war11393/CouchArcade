/**
 * Wx 本地存储服务桩 —— 第二阶段联通实现。
 * 目标 API：wx.setStorageSync / wx.getStorageSync / wx.removeStorageSync / wx.clearStorageSync
 */

import { IStorageService } from '../IServices';

export class WxStorageService implements IStorageService {
    public get<T>(key: string, defaultValue?: T): T | undefined {
        // TODO(wechat-phase2): 接入 wx.getStorageSync(key)
        //   const v = wx.getStorageSync(key);
        //   return (v === '' || v === undefined || v === null) ? defaultValue : (v as T);
        //   注意：wx.getStorageSync 读取不存在的 key 返回 ''（空字符串），不是 undefined，
        //   必须显式判空，否则会把 '' 当成有效值。
        //   验证方法：真机首次启动无缓存时，登录流程正常回落到默认用户。
        return defaultValue;
    }

    public set<T>(key: string, value: T): void {
        // TODO(wechat-phase2): 接入 wx.setStorageSync(key, value)
        //   注意：小游戏单个 key 上限 1MB，全部数据上限 10MB，超限会抛异常，
        //   战绩等大数组建议只存摘要或改存云端。
        //   验证方法：真机设置后杀进程重进，数据仍在。
    }

    public remove(key: string): void {
        // TODO(wechat-phase2): 接入 wx.removeStorageSync(key)
    }

    public clear(): void {
        // TODO(wechat-phase2): 接入 wx.clearStorageSync()
        //   注意：会清空全部本地缓存（含登录态），仅退出登录时使用。
    }
}
