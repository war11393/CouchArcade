/**
 * 战绩服务：对局结束后经 ICloudService 写入战绩。
 *
 * Mock 阶段：写入内存集合并打印日志（规格要求）。
 * 第二阶段：云函数 settleGame 写入 match_records 集合。
 *
 * ⚠️ Mock 云函数处理器（settleGame / login）的**注册不在本文件** ——
 * 已迁至 `core/services/mock/MockCloudHandlers.ts`，由 `ServiceLocator.init()` 调用。
 * 原因：本文件 import 了 ServiceLocator，若 ServiceLocator 反向 import 本文件
 * 会形成循环依赖；而旧实现把注册挂在 `AppBootstrap.onLoad` 上（该组件从未被挂到
 * 任何场景）→ 注册从未发生，战绩链路一直是断的。详见该文件顶部说明。
 */

import { COLLECTIONS, CLOUD_FUNCTIONS } from '../config/Collections';
import { GameId } from '../config/GameList';
import { GameResult } from '../games/common/IGame';
import { services } from '../core/ServiceLocator';

/** 战绩记录结构（与 match_records 集合设计一致）。 */
export interface MatchRecord {
    openid: string;
    nickname: string;
    gameId: GameId;
    roomId: string;
    /** 'win' | 'lose' | 'draw' */
    result: 'win' | 'lose' | 'draw';
    /** 本局得分/步数 */
    score: number;
    moves: number;
    /** 对手 openid */
    opponentId: string;
    /** 对局时长（毫秒） */
    durationMs: number;
    /** 结束时间戳 */
    createdAt: number;
}

/**
 * 写入一局战绩。
 *
 * @returns 记录 id
 */
export async function saveMatchRecord(
    result: GameResult,
    myPlayerId: string,
    roomId: string,
): Promise<string> {
    const mine = result.stats.find((s) => s.playerId === myPlayerId);
    const opponent = result.stats.find((s) => s.playerId !== myPlayerId);

    const outcome: MatchRecord['result'] = result.draw
        ? 'draw'
        : result.winnerId === myPlayerId
          ? 'win'
          : 'lose';

    const record: MatchRecord = {
        openid: myPlayerId,
        nickname: mine ? mine.nickname : '',
        gameId: result.gameId,
        roomId,
        result: outcome,
        score: mine ? mine.score : 0,
        moves: mine ? mine.moves : 0,
        opponentId: opponent ? opponent.playerId : '',
        durationMs: result.durationMs,
        createdAt: Date.now(),
    };

    // 主路径：走云函数 settleGame（Mock 阶段通过注册的处理器落到内存集合）
    const id = await services.cloud.callFunction<MatchRecord, string>(
        CLOUD_FUNCTIONS.SETTLE_GAME,
        record,
    );

    console.log(
        `[StatsService] 战绩已写入（${outcome}）：`,
        JSON.stringify(record, null, 2),
    );
    return id || '';
}

/**
 * 查询历史战绩（大厅/个人页使用）。
 */
export async function queryMatchRecords(openid: string): Promise<MatchRecord[]> {
    return services.cloud.queryCollection<MatchRecord>(COLLECTIONS.MATCH_RECORDS, { openid });
}
