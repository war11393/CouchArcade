/**
 * Mock 本地存储：优先用 localStorage，无 localStorage 环境（单测）退化为内存 Map。
 */

import { IStorageService } from '../IServices';

export class MockStorageService implements IStorageService {
    private readonly _mem = new Map<string, string>();
    private readonly _useLocal: boolean;

    constructor() {
        this._useLocal = typeof localStorage !== 'undefined';
    }

    public get<T>(key: string, defaultValue?: T): T | undefined {
        const raw = this._useLocal ? localStorage.getItem(key) : this._mem.get(key) ?? null;
        if (raw === null || raw === undefined) {
            return defaultValue;
        }
        try {
            return JSON.parse(raw) as T;
        } catch (err) {
            console.warn(`[MockStorage] 解析失败，返回默认值: ${key}`, err);
            return defaultValue;
        }
    }

    public set<T>(key: string, value: T): void {
        const raw = JSON.stringify(value);
        if (this._useLocal) {
            localStorage.setItem(key, raw);
        } else {
            this._mem.set(key, raw);
        }
    }

    public remove(key: string): void {
        if (this._useLocal) {
            localStorage.removeItem(key);
        } else {
            this._mem.delete(key);
        }
    }

    public clear(): void {
        if (this._useLocal) {
            localStorage.clear();
        } else {
            this._mem.clear();
        }
    }
}
