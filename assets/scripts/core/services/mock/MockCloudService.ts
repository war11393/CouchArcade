/**
 * Mock 云开发服务：以内存 Map 模拟集合读写与 watch 回调。
 *
 * 目的：让 ICloudService 的调用方（登录、战绩写入、房间 watch）
 * 在第一阶段就能跑通完整代码路径，第二阶段切换 WxCloudService 即可。
 */

import { ICloudService } from '../IServices';

interface MockDoc {
    _id: string;
    [key: string]: unknown;
}

/** 集合监听器登记项。 */
interface WatchEntry {
    collection: string;
    query: Record<string, unknown>;
    cb: (docs: MockDoc[]) => void;
}

export class MockCloudService implements ICloudService {
    private readonly _db = new Map<string, MockDoc[]>();
    private readonly _watchers: WatchEntry[] = [];
    private _idSeq = 1;
    private _inited = false;

    public init(): void {
        if (this._inited) {
            return;
        }
        this._inited = true;
        console.log('[MockCloud] 云开发已初始化（内存模拟，环境=Mock）');
    }

    /**
     * 模拟云函数调用。
     *
     * 第二阶段真实实现会走 wx.cloud.callFunction(name, { data })，
     * 这里通过一个可注册的「云函数处理器表」模拟服务端逻辑，
     * 便于第一阶段就验证调用方代码的正确性。
     */
    public async callFunction<TReq = unknown, TRes = unknown>(
        name: string,
        data: TReq,
    ): Promise<TRes> {
        this.init();
        // 模拟云函数冷启动/网络耗时
        await this._delay(this._rand(60, 180));

        const handler = MockCloudService._handlers.get(name);
        if (!handler) {
            console.warn(`[MockCloud] 云函数 ${name} 无 Mock 处理器，返回空对象`);
            return {} as TRes;
        }
        const result = handler(data, this);
        console.log(`[MockCloud] 调用云函数 ${name}`, data, '→', result);
        return result as TRes;
    }

    public watchCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
        cb: (docs: T[]) => void,
    ): () => void {
        const entry: WatchEntry = {
            collection: name,
            query,
            cb: cb as (docs: MockDoc[]) => void,
        };
        this._watchers.push(entry);
        console.log(`[MockCloud] watch 集合 ${name}`, query);

        // 立即回调一次当前快照，模拟真实 watch 的 initial 推送
        this._notifyOne(entry);

        return () => {
            const i = this._watchers.indexOf(entry);
            if (i >= 0) {
                this._watchers.splice(i, 1);
            }
            console.log(`[MockCloud] 取消 watch 集合 ${name}`);
        };
    }

    public async queryCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
    ): Promise<T[]> {
        this.init();
        await this._delay(this._rand(30, 100));
        const docs = this._db.get(name) ?? [];
        return this._match(docs, query) as T[];
    }

    public async addDocument<T = unknown>(name: string, doc: T): Promise<string> {
        this.init();
        await this._delay(this._rand(30, 100));

        const _id = `${name}_${this._idSeq++}`;
        const record: MockDoc = { _id, ...(doc as Record<string, unknown>) };
        let list = this._db.get(name);
        if (!list) {
            list = [];
            this._db.set(name, list);
        }
        list.push(record);

        // 通知该集合的监听者
        for (const w of this._watchers.slice()) {
            if (w.collection === name) {
                this._notifyOne(w);
            }
        }
        console.log(`[MockCloud] 写入 ${name} _id=${_id}`);
        return _id;
    }

    /** 更新文档（Mock 专用，真实阶段由云函数内部完成）。 */
    public async updateDocument(name: string, id: string, patch: Record<string, unknown>): Promise<void> {
        this.init();
        const list = this._db.get(name);
        if (!list) {
            return;
        }
        const doc = list.find((d) => d._id === id);
        if (!doc) {
            return;
        }
        Object.assign(doc, patch);
        this._notifyAll();
    }

    /** 调试用：打印全部集合内容。 */
    public dump(): void {
        console.log('===== MockCloud 数据快照 =====');
        this._db.forEach((docs, name) => {
            console.log(`[${name}] (${docs.length} 条)`, docs);
        });
        console.log('=============================');
    }

    /** 清空全部数据（测试用）。 */
    public reset(): void {
        this._db.clear();
        this._watchers.length = 0;
        this._idSeq = 1;
    }

    // ==================== 内部 ====================

    private _notifyOne(entry: WatchEntry): void {
        const docs = this._db.get(entry.collection) ?? [];
        const matched = this._match(docs, entry.query);
        setTimeout(() => {
            try {
                entry.cb(matched);
            } catch (err) {
                console.error(`[MockCloud] watch 回调异常 ${entry.collection}:`, err);
            }
        }, 0);
    }

    private _notifyAll(): void {
        for (const w of this._watchers.slice()) {
            this._notifyOne(w);
        }
    }

    /** 极简查询匹配：支持等值匹配与 '_id' 匹配。 */
    private _match(docs: MockDoc[], query: Record<string, unknown>): MockDoc[] {
        const keys = Object.keys(query);
        if (keys.length === 0) {
            return docs.slice();
        }
        return docs.filter((d) => keys.every((k) => d[k] === query[k]));
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private _rand(min: number, max: number): number {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    // ==================== 可注册的云函数处理器 ====================

    private static readonly _handlers = new Map<
        string,
        (data: unknown, svc: MockCloudService) => unknown
    >();

    /**
     * 注册 Mock 云函数处理器。
     * 第一阶段由各模块（如战绩结算）在初始化时注册，
     * 第二阶段同名逻辑会真正部署到微信云函数中。
     */
    public static registerHandler(
        name: string,
        fn: (data: unknown, svc: MockCloudService) => unknown,
    ): void {
        MockCloudService._handlers.set(name, fn);
    }

    public static hasHandler(name: string): boolean {
        return MockCloudService._handlers.has(name);
    }
}
