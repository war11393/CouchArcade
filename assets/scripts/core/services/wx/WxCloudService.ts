/**
 * Wx 云开发服务桩 —— 第二阶段联通实现。
 *
 * 目标 API：wx.cloud.init / wx.cloud.callFunction /
 *          wx.cloud.database().collection().watch / .get / .add
 *
 * 实时通道选型结论见 docs/REALTIME_CHANNEL_DECISION.md：
 * 本阶段选型为「云数据库实时数据推送（watch）」，理由见该文档。
 */

import { AppConfig } from '../../../config/AppConfig';
import { ICloudService } from '../IServices';

export class WxCloudService implements ICloudService {
    public init(): void {
        // TODO(wechat-phase2): 初始化云开发环境
        //   wx.cloud.init({
        //       env: AppConfig.CLOUD_ENV,       // 需替换为真实环境 ID（AppConfig.CLOUD_ENV）
        //       traceUser: true,                // 记录用户访问，便于后台排查
        //   });
        //   注意：必须在任何 callFunction 之前调用；建议在 App.onLoad 最早处执行。
        //   验证方法：真机控制台无「cloud init failed」报错，且云函数调用返回正常。
        console.log(
            `[WxCloudService] init() 待联通（env=${AppConfig.CLOUD_ENV}，appid=${AppConfig.WX_APPID}）`,
        );
    }

    public async callFunction<TReq = unknown, TRes = unknown>(
        name: string,
        data: TReq,
    ): Promise<TRes> {
        // TODO(wechat-phase2): 接入 wx.cloud.callFunction
        //   const res = await wx.cloud.callFunction({ name, data });
        //   return res.result as TRes;
        //   注意：
        //   1. 云函数返回必须是可 JSON 序列化的对象，Date/undefined 会丢失；
        //   2. 单个返回值上限 1MB，大列表务必分页；
        //   3. 需在 cloudfunctions/ 目录下部署同名云函数（本仓库已提供源码）。
        //   验证方法：真机调用 login 云函数，返回 openid。
        throw new Error(`[WxCloudService] callFunction(${name}) 未实现（第二阶段联通）`);
    }

    public watchCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
        cb: (docs: T[]) => void,
    ): () => void {
        // TODO(wechat-phase2): 接入云数据库实时监听
        //   const db = wx.cloud.database();
        //   const watcher = db.collection(name)
        //       .where(query)
        //       .watch({
        //           onChange: (snapshot) => cb(snapshot.docs as T[]),
        //           onError: (err) => console.error('[watch] error', err),
        //       });
        //   return () => watcher.close();
        //   注意：
        //   1. 每个客户端最多同时存在 5 个 watch 连接，超出会报错，
        //      因此对局中只保留「当前房间」一个 watch，离开房间必须 close；
        //   2. watch 断线会自动重连，但重连后仅推送增量，
        //      必须结合 getRoomState 云函数做一次全量对账（断线重连补偿）；
        //   3. 权限：集合需设置为「所有用户可读」或按 _openid 读写，否则 watch 静默失败。
        //   验证方法：真机两个账号在同一房间，A 准备后 B 的界面 1 秒内更新。
        return () => {
            // TODO(wechat-phase2): watcher.close()
        };
    }

    public async queryCollection<T = unknown>(
        name: string,
        query: Record<string, unknown>,
    ): Promise<T[]> {
        // TODO(wechat-phase2): 接入 db.collection(name).where(query).get()
        //   注意：小程序端 get() 单次最多返回 20 条，云函数端 100 条，
        //   超出需分页（skip/limit），本项目的 rooms/战绩查询均需注意。
        //   验证方法：真机查询房间列表返回非空。
        throw new Error(`[WxCloudService] queryCollection(${name}) 未实现（第二阶段联通）`);
    }

    public async addDocument<T = unknown>(name: string, doc: T): Promise<string> {
        // TODO(wechat-phase2): 接入 db.collection(name).add({ data: doc })
        //   注意：从客户端 add 会自动写入 _openid 字段；如需写入他人数据（如战绩
        //   结算），必须走云函数（云函数以管理员权限运行）。
        //   验证方法：真机结算一局后 match_records 集合新增一条记录。
        throw new Error(`[WxCloudService] addDocument(${name}) 未实现（第二阶段联通）`);
    }
}
