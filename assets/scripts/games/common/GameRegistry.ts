/**
 * 游戏注册表：把 GameId 映射到「规则逻辑 + UI 视图」的工厂函数。
 *
 * 新增游戏只需两步：
 * 1. 在 config/GameList.ts 追加 GameMeta；
 * 2. 在此处 register 一个 factory。
 * GameScene 完全配置驱动，无需修改。
 */

import { GameId } from '../../config/GameList';
import { IGame, GameContext } from './IGame';
import { GomokuGame } from '../gomoku/GomokuGame';
import { PlaneHuntGame } from '../planehunt/PlaneHuntGame';

/** 游戏工厂签名。 */
export type GameFactory = (ctx: GameContext) => IGame;

/** 注册表内部存储。 */
const _registry = new Map<GameId, GameFactory>();

/** 注册一款游戏。 */
export function registerGame(id: GameId, factory: GameFactory): void {
    if (_registry.has(id)) {
        console.warn(`[GameRegistry] 游戏 ${id} 已注册，将被覆盖`);
    }
    _registry.set(id, factory);
}

/** 按 id 创建游戏实例；未注册返回 null。 */
export function createGame(id: GameId, ctx: GameContext): IGame | null {
    const factory = _registry.get(id);
    if (!factory) {
        console.error(`[GameRegistry] 未注册的游戏: ${id}`);
        return null;
    }
    return factory(ctx);
}

/** 是否已注册（大厅据此置灰未实现的游戏）。 */
export function isGameRegistered(id: GameId): boolean {
    return _registry.has(id);
}

// ==========================================================================
// 内置游戏注册
// ==========================================================================

registerGame(GameId.GOMOKU, (ctx) => new GomokuGame(ctx));
registerGame(GameId.PLANE_HUNT, (ctx) => new PlaneHuntGame(ctx));
