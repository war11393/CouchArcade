/**
 * Wx 云开发服务 —— 第二阶段真实实现。
 *
 * 目标 API：wx.cloud.init / wx.cloud.callFunction /
 *          wx.cloud.database().collection().watch / .get / .add
 *
 * 实时通道选型结论见 docs/REALTIME_CHANNEL_DECISION.md：
 * 本阶段选型为「云数据库实时数据推送（watch）」。
 *
 * 契约：云函数统一返回 { code, success, data }（见 cloudfunctions/common/index.js 的 ok/fail）。
 * 本文件负责把该信封「解包」成业务层要的 data，并在失败时抛出可识别的错误。
 */

import { AppConfig } from '../../../config/AppConfig';
import { ERR } from '../../../config/CloudErrors';
import { CloudError } from '../../../config/CloudErrors';
import { ICloudService } from '../IServices';

/** 云函数统一响应信封（与 cloudfunctions/common/index.js 的 ok/fail 对齐）。 */
interface CloudEnvelope<T> {
    code: number;
    success: boolean;
    data?: T;
    message?: string;
}

/** wx.cloud.callFunction 的包装结果。 */
interface CallFunctionEnvelope<T> {
    /** 云函数返回的信封。 */
    result?: CloudEnvelope<T>;
    errMsg?: string;
}

export class WxCloudService implements ICloudService {
    private _inited = false;

    /**
     * 初始化云开发环境。
     *
     * 幂等：重复调用直接返回 —— 因为 ensureServices() 与 AppBootstrap 都可能调用它。
     */
    public init(): void {
        if (this._inited) {
            return;
        }

        if (!this._hasCloud()) {
            // 非小游戏环境（如编辑器预览误切 Wx 实现）不应硬崩，
            // 报错并降级，便于定位「USE_MOCK 忘了打开」这类配置错误。
            console.error(
                '[WxCloudService] 当前环境无 wx.cloud，请确认运行在微信小游戏环境且 AppConfig.USE_MOCK=false',
            );
            return;
        }

        if (!AppConfig.CLOUD_ENV || (AppConfig.CLOUD_ENV as string) === 'TODO') {
            console.error(
                '[WxCloudService] AppConfig.CLOUD_ENV 仍是占位值 "TODO"，云函数调用必然失败。' +
                    '请在微信云开发控制台创建环境后回填环境 ID。',
            );
        }

        try {
            wx.cloud.init({
                env: AppConfig.CLOUD_ENV,
                traceUser: true,
            });
            this._inited = true;
            console.log(`[WxCloudService] 云环境初始化完成 env=${AppConfig.CLOUD_ENV}`);
        } catch (err) {
            // init 失败必须显式暴露：后续所有 callFunction 都会失败，
            // 静默吞掉会让排查变得极困难。
            console.error('[WxCloudService] 云环境初始化失败:', err);
        }
    }

    /**
     * 调用云函数，并解包 { code, success, data } 信封。
     *
     * 抛出 CloudError（含错误码）的情形：
     *   1. 云函数未部署 / 网络失败 → wx 层 errMsg
     *   2. business code !== 0     → 服务端业务错误（房间不存在等）
     */
    public async callFunction<TReq = unknown, TRes = unknown>(
        name: string,
        data: TReq,
    ): Promise<TRes> {
        if (!this._hasCloud()) {
            throw new CloudError(ERR.NO_CLOUD, `[WxCloudService] 无 wx.cloud，无法调用 ${name}`);
        }
        if (!this._inited) {
            // 兜底：避免「忘了 init」导致 -404011 之类的隐晦报错
            this.init();
        }

        let res: CallFunctionEnvelope<TRes>;
        try {
            res = (await wx.cloud.callFunction({
                name,
                data: data as unknown,
            })) as unknown as CallFunctionEnvelope<TRes>;
        } catch (err) {
            const msg = (err as { errMsg?: string })?.errMsg ?? String(err);
            throw new CloudError(
                ERR.CALL_FAIL,
                `[WxCloudService] callFunction(${name}) 失败: ${msg}`,
            );
        }

        const envelope = res && res.result;
        if (!envelope) {
            throw new CloudError(
                ERR.BAD_RESPONSE,
                `[WxCloudService] callFunction(${name}) 返回体为空: ${res?.errMsg ?? 'no result'}`,
            );
        }

        if (envelope.success === false || (envelope.code !== undefined && envelope.code !== ERR.OK)) {
            throw new CloudError(
                envelope.code ?? ERR.UNKNOWN,
                envelope.message || `[WxCloudService] ${name} 业务失败`,
            );
        }

        // 注意：data 允许为 null（如 getRoomState 找不到房间时返回 ok(null)），
        // 因此这里不能把 null 误判成失败，交由调用方判断。
        return (envelope.data ?? null) as TRes;
    }

    /**
     * 监听集合变化（实时数据推送）。
     *
     * 约束（务必遵守，否则线上会出现难查的故障）：
     *   1. 每客户端最多 5 个 watch 连接 —— 调用方必须在离开房间/切场景时调用返回的取消函数；
     *   2. watch 断线会自动重连但只推增量 —— 业务层需配合 getRoomState 做全量对账；
     *   3. 集合权限必须是「所有用户可读」，否则 watch 静默失败（无报错、无回调）。
     */
    public watchCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
        cb: (docs: T[]) => void,
    ): () => void {
        if (!this._hasCloud()) {
            console.error(`[WxCloudService] 无 wx.cloud，无法 watch ${name}`);
            return () => undefined;
        }
        if (!this._inited) {
            this.init();
        }

        let closed = false;
        let watcher: WxCloudWatcher | null = null;

        try {
            watcher = wx.cloud
                .database()
                .collection<T>(name)
                .where(query)
                .watch({
                    onChange: (snapshot: WxCloudDocumentSnapshot<T>) => {
                        if (closed) {
                            return;
                        }
                        try {
                            cb(snapshot.docs ?? []);
                        } catch (err) {
                            console.error(`[WxCloudService] watch(${name}) 回调异常:`, err);
                        }
                    },
                    onError: (err: unknown) => {
                        // 静默失败排查提示：若这里长时间无输出且无回调，
                        // 优先检查集合权限与 where 条件字段是否存在。
                        console.error(`[WxCloudService] watch(${name}) 错误:`, err);
                    },
                });
        } catch (err) {
            console.error(`[WxCloudService] watch(${name}) 建立失败:`, err);
            return () => undefined;
        }

        console.log(`[WxCloudService] 已监听 ${name}`, query);

        return () => {
            if (closed) {
                return;
            }
            closed = true;
            try {
                const r = watcher?.close();
                // close() 可能返回 Promise，吞掉其 rejection 以免产生未处理拒绝
                if (r && typeof (r as Promise<void>).catch === 'function') {
                    (r as Promise<void>).catch((err: unknown) =>
                        console.warn(`[WxCloudService] watch(${name}) close 异常:`, err),
                    );
                }
            } catch (err) {
                console.warn(`[WxCloudService] watch(${name}) close 异常:`, err);
            }
            console.log(`[WxCloudService] 已取消监听 ${name}`);
        };
    }

    /**
     * 一次性查询集合。
     *
     * 注意：小程序端单次 get() 最多返回 20 条，云函数端 100 条。
     * 需要更多必须显式分页 —— 本方法在达到 20 条上限时打告警，
     * 避免「数据莫名变少」被误判为云函数问题。
     */
    public async queryCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
    ): Promise<T[]> {
        if (!this._hasCloud()) {
            throw new CloudError(ERR.NO_CLOUD, `[WxCloudService] 无 wx.cloud，无法查询 ${name}`);
        }
        if (!this._inited) {
            this.init();
        }

        try {
            const res = await wx.cloud.database().collection<T>(name).where(query).get();
            const docs = res?.data ?? [];
            if (docs.length >= 20) {
                console.warn(
                    `[WxCloudService] queryCollection(${name}) 返回 ${docs.length} 条，` +
                        '已达小程序端单次上限（20），如需全量请分页。',
                );
            }
            return docs;
        } catch (err) {
            throw new CloudError(
                ERR.CALL_FAIL,
                `[WxCloudService] queryCollection(${name}) 失败: ${(err as { errMsg?: string })?.errMsg ?? String(err)}`,
            );
        }
    }

    /**
     * 写入文档。
     *
     * 重要：客户端直写只能写自己的数据（自动带 _openid）。
     * 战绩结算等需要写他人数据的场景**必须走云函数**（服务端以管理员权限运行）。
     */
    public async addDocument<T = unknown>(name: string, doc: T): Promise<string> {
        if (!this._hasCloud()) {
            throw new CloudError(ERR.NO_CLOUD, `[WxCloudService] 无 wx.cloud，无法写入 ${name}`);
        }
        if (!this._inited) {
            this.init();
        }

        try {
            const res = await wx.cloud.database().collection(name).add({ data: doc as unknown });
            return res?._id ?? '';
        } catch (err) {
            throw new CloudError(
                ERR.CALL_FAIL,
                `[WxCloudService] addDocument(${name}) 失败: ${(err as { errMsg?: string })?.errMsg ?? String(err)}`,
            );
        }
    }

    /** 当前环境是否具备 wx.cloud。 */
    private _hasCloud(): boolean {
        return typeof wx !== 'undefined' && !!wx.cloud;
    }
}
