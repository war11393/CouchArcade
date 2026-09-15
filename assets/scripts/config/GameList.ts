/**
 * 游戏列表配置（配置驱动大厅）。
 *
 * 新增一款游戏只需：
 * 1. 在此处追加一条 GameMeta；
 * 2. 在 assets/scripts/games/<yourgame>/ 下实现 IGame；
 * 3. 在 GameRegistry 中注册对应的 GameFactory。
 * 大厅、房间、对局场景均无需改动。
 */

import { PALETTE } from './UITheme';

/** 游戏唯一标识，与云数据库集合/云函数命名保持一致。 */
export enum GameId {
    PLANE_HUNT = 'planehunt',
    GOMOKU = 'gomoku',
}

/** 游戏元数据，驱动大厅卡片与房间配置。 */
export interface GameMeta {
    id: GameId;
    /** 显示名称 */
    name: string;
    /** 一句话简介 */
    desc: string;
    /** 图标占位色（取自设计令牌 PALETTE，无美术资源时用纯色块 + 名称首字渲染） */
    iconColor: string;
    /** 图标文字（取名称首字或自定义） */
    iconText: string;
    /** 该游戏所需玩家数（MVP 两款均为 2 人） */
    playerCount: number;
    /** 服务器权威布局/落子校验所使用的集合名（第二阶段云开发使用） */
    collectionName: string;
    /** 该游戏的云函数命名前缀 */
    cloudFunctionPrefix: string;
    /** 是否已实现（未实现则大厅置灰） */
    enabled: boolean;
    /** 排序权重，越小越靠前 */
    order: number;
}

/** MVP 游戏清单：寻机头 + 五子棋。 */
export const GAME_LIST: readonly GameMeta[] = [
    {
        id: GameId.PLANE_HUNT,
        name: '寻机头',
        // 文案长度约束：卡片描述列宽 320px / 22px 字号，单行 ≤14 个全角字符（见 docs/UI_DESIGN.md）
        desc: '12×12 搜寻 5 架飞机',
        iconColor: PALETTE.primary,
        iconText: '机',
        playerCount: 2,
        collectionName: 'games_planehunt',
        cloudFunctionPrefix: 'planehunt_',
        enabled: true,
        order: 1,
    },
    {
        id: GameId.GOMOKU,
        name: '五子棋',
        desc: '15×15 连五者胜',
        iconColor: PALETTE.accent,
        iconText: '棋',
        playerCount: 2,
        collectionName: 'games_gomoku',
        cloudFunctionPrefix: 'gomoku_',
        enabled: true,
        order: 2,
    },
];

/** 按 id 查配置，未找到返回 undefined（调用方需判空）。 */
export function getGameMeta(id: GameId): GameMeta | undefined {
    return GAME_LIST.find((g) => g.id === id);
}

/** 按 id 查配置，未找到抛错（用于确定存在的场景）。 */
export function requireGameMeta(id: GameId): GameMeta {
    const meta = getGameMeta(id);
    if (!meta) {
        throw new Error(`[GameList] 未注册的游戏 id: ${id}`);
    }
    return meta;
}

/** 排序后的游戏清单（大厅渲染直接使用）。 */
export function getSortedGameList(): GameMeta[] {
    return GAME_LIST.slice().sort((a, b) => a.order - b.order);
}
