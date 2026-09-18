/**
 * Wx 本地存储服务 —— 第二阶段真实实现。
 * 目标 API：wx.setStorageSync / wx.getStorageSync / wx.removeStorageSync / wx.clearStorageSync
 *
 * 核心坑（务必保留判空逻辑）：
 *   wx.getStorageSync 读取**不存在的 key 返回空字符串 ''**，而不是 undefined。
 *   若直接返回它，调用方拿到的 '' 会被当成「有效值」，
 *   例如 `cached ?? defaultUser` 中的 ?? 不生效（'' 不是 nullish）→ 首启拿到空用户。
 */

import { IStorageService } from '../IServices';

export class WxStorageService implements IStorageService {
    public get<T>(key: string, defaultValue?: T): T | undefined {
        try {
            const v = wx.getStorageSync(key);
            // 关键：'' / undefined / null 一律视为「无值」，回落到默认值。
            // 注意不能用 ?? —— '' 不是 nullish，这正是官方接口的陷阱所在。
            if (v === '' || v === undefined || v === null) {
                return defaultValue;
            }
            return v as T;
        } catch (err) {
            console.warn(`[WxStorage] get(${key}) 失败:`, err);
            return defaultValue;
        }
    }

    public set<T>(key: string, value: T): void {
        try {
            wx.setStorageSync(key, value);
        } catch (err) {
            // 单 key 上限 1MB、总量上限 10MB，超限会抛异常。
            // 这里降级为告警而非抛出 —— 存储失败不应阻断游戏主流程，
            // 但必须留下日志，否则「设置没生效」会很难查。
            console.error(`[WxStorage] set(${key}) 失败（可能超出容量上限）:`, err);
        }
    }

    public remove(key: string): void {
        try {
            wx.removeStorageSync(key);
        } catch (err) {
            console.warn(`[WxStorage] remove(${key}) 失败:`, err);
        }
    }

    public clear(): void {
        try {
            // 会清空全部本地缓存（含登录态），仅退出登录等场景使用
            wx.clearStorageSync();
            console.log('[WxStorage] 已清空全部本地缓存');
        } catch (err) {
            console.error('[WxStorage] clear() 失败:', err);
        }
    }
}
