import { director, Director, game, Game } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { GameId } from '../config/GameList';

/**
 * 跨场景/跨模块的全局事件名常量表。
 *
 * 设计约定：
 * - 事件总线只承载「框架级/跨模块」通知，模块内部通信优先直接引用回调；
 * - 所有事件 payload 使用强类型接口描述，避免 any 扩散。
 */
export enum GameEvent {
    /** 登录完成，payload: UserInfo */
    LOGIN_SUCCESS = 'login-success',
    /** 房间状态变化（Mock/真机通用），payload: RoomState */
    ROOM_STATE_CHANGED = 'room-state-changed',
    /** 对局开始，payload: { roomId, gameId, seed } */
    GAME_START = 'game-start',
    /** 对局结束，payload: GameResult */
    GAME_OVER = 'game-over',
    /** 收到表情消息，payload: EmoteMessage */
    EMOTE_RECEIVED = 'emote-received',
    /** 玩家断线，payload: { playerId } */
    PLAYER_OFFLINE = 'player-offline',
    /** 玩家重连成功，payload: { playerId } */
    PLAYER_RECONNECTED = 'player-reconnected',
    /** 网络状态提示，payload: { text, level } */
    TOAST = 'toast',
    /** 安全区变化（旋转/尺寸变化） */
    SAFE_AREA_CHANGED = 'safe-area-changed',
}

/** UI 顶部/底部状态栏共享的对局信息。 */
export interface EmoteMessage {
    playerId: string;
    emoteId: number;
}

/** 统一 UI 提示等级，供 ToastPresenter 决定配色。 */
export enum ToastLevel {
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

export interface ToastPayload {
    text: string;
    level: ToastLevel;
}

export interface SafeAreaPayload {
    /** 顶部需要避让的高度（px，设计分辨率坐标系） */
    top: number;
    /** 底部需要避让的高度（px，设计分辨率坐标系） */
    bottom: number;
    /** 左侧需要避让的宽度（px，设计分辨率坐标系） */
    left: number;
    /** 右侧需要避让的宽度（px，设计分辨率坐标系） */
    right: number;
    /** 实际屏幕宽高（px，物理像素或 CSS 像素，由平台层给定） */
    screenWidth: number;
    screenHeight: number;
}

type Handler = (...args: any[]) => void;

interface ListenerEntry {
    handler: Handler;
    target: unknown;
    once: boolean;
}

/**
 * 轻量级事件总线（全局单例）。
 *
 * 为什么自己写而不是用 cc 的 EventTarget：
 * - 需要一个「不依赖节点生命周期」的全局总线，节点销毁后监听仍需可清理；
 * - 需要 offTarget 能力，避免 UI 销毁后回调野指针；
 * - 便于单元测试（纯 TS，无 Cocos 依赖）。
 */
export class EventBus {
    private static _instance: EventBus | null = null;
    private readonly _map = new Map<string, ListenerEntry[]>();

    public static get instance(): EventBus {
        if (!EventBus._instance) {
            EventBus._instance = new EventBus();
        }
        return EventBus._instance;
    }

    /** 注册监听；重复注册同一 handler+target 会被去重。 */
    public on(event: string, handler: Handler, target?: unknown): void {
        this._add(event, handler, target, false);
    }

    /** 注册一次性监听。 */
    public once(event: string, handler: Handler, target?: unknown): void {
        this._add(event, handler, target, true);
    }

    /** 注销指定 handler。target 省略时按 handler 匹配全部。 */
    public off(event: string, handler: Handler, target?: unknown): void {
        const list = this._map.get(event);
        if (!list) {
            return;
        }
        for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i];
            if (e.handler === handler && (target === undefined || e.target === target)) {
                list.splice(i, 1);
            }
        }
        if (list.length === 0) {
            this._map.delete(event);
        }
    }

    /** 注销某个 target 的所有监听，UI 组件 onDestroy 必调，防止野回调。 */
    public offTarget(target: unknown): void {
        this._map.forEach((list, key) => {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].target === target) {
                    list.splice(i, 1);
                }
            }
            if (list.length === 0) {
                this._map.delete(key);
            }
        });
    }

    /**
     * 同步派发。单个监听抛错不会中断其余监听（错误仅告警日志），
     * 保证 UI 层某个组件异常不会连带打挂核心流程。
     */
    public emit(event: string, ...args: any[]): void {
        const list = this._map.get(event);
        if (!list || list.length === 0) {
            if (AppConfig.LOG_VERBOSE) {
                console.log(`[EventBus] (no listener) ${event}`);
            }
            return;
        }
        // 复制一份，允许监听内部增删监听
        const snapshot = list.slice();
        for (const entry of snapshot) {
            if (entry.once) {
                this.off(event, entry.handler, entry.target);
            }
            try {
                entry.handler.apply(entry.target, args);
            } catch (err) {
                console.error(`[EventBus] listener error on "${event}":`, err);
            }
        }
    }

    /** 清空全部监听（切账号/重登时使用）。 */
    public clear(): void {
        this._map.clear();
    }

    /** 调试用：查看某事件监听数量。 */
    public listenerCount(event: string): number {
        const list = this._map.get(event);
        return list ? list.length : 0;
    }

    private _add(event: string, handler: Handler, target: unknown, once: boolean): void {
        let list = this._map.get(event);
        if (!list) {
            list = [];
            this._map.set(event, list);
        }
        for (const e of list) {
            if (e.handler === handler && e.target === target) {
                return;
            }
        }
        list.push({ handler, target, once });
    }
}

/** 便捷导出，避免到处写 EventBus.instance。 */
export const eventBus = EventBus.instance;

/** 未使用的类型占位，保持 import 与引擎类型可用性（避免误删）。 */
export type __EngineRefs = { d: Director; g: Game; f: typeof director; gf: typeof game; gid: GameId };
