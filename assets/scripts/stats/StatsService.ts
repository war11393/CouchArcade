/**
 * 战绩服务：对局结束后经 ICloudService 写入战绩。
 *
 * Mock 阶段：写入内存集合并打印日志（规格要求）。
 * 第二阶段：云函数 settleGame 写入 match_records 集合。
 */

import { COLLECTIONS, CLOUD_FUNCTIONS } from '../config/Collections';
import { GameId } from '../config/GameList';
import { GameResult } from '../games/common/IGame';
import { MockCloudService } from '../core/services/mock/MockCloudService';
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
 * 注册 Mock 云函数处理器（仅 Mock 模式生效）。
 *
 * 目的：让「写战绩」这条云函数调用链在第一阶段就跑通，
 * 第二阶段部署真实云函数后无需修改调用方代码。
 */
export function registerCloudHandlers(): void {
    MockCloudService.registerHandler(CLOUD_FUNCTIONS.SETTLE_GAME, (data) => {
        // 模拟服务端落库：写入 match_records 集合
        const svc = _mockCloudRef;
        if (svc) {
            void svc.addDocument(COLLECTIONS.MATCH_RECORDS, data);
        }
        console.log('[MockCloud] settleGame 处理器：战绩已落库');
        return `${COLLECTIONS.MATCH_RECORDS}_mock`;
    });

    MockCloudService.registerHandler(CLOUD_FUNCTIONS.LOGIN, (data) => {
        // 模拟 login 云函数返回 openid
        const d = data as { code?: string } | undefined;
        void d;
        return { openid: 'mock-openid-0001', ok: true };
    });

    console.log('[StatsService] Mock 云函数处理器注册完成');
}

/** 延迟绑定 MockCloudService 引用（避免循环依赖）。 */
let _mockCloudRef: MockCloudService | null = null;
export function bindMockCloud(svc: MockCloudService): void {
    _mockCloudRef = svc;
}

/**
 * 查询历史战绩（大厅/个人页使用）。
 */
export async function queryMatchRecords(openid: string): Promise<MatchRecord[]> {
    return services.cloud.queryCollection<MatchRecord>(COLLECTIONS.MATCH_RECORDS, { openid });
}
