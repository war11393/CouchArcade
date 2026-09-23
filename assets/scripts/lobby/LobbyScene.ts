/**
 * Lobby 场景控制器（游戏大厅 / 游戏列表页）。
 *
 * ⚠️ UI 是【静态节点】，定义在 tools/ui-trees.js 的 lobbyTree()，由 gen-scenes.js
 * 编译进 Lobby.scene。本控制器**不再运行时创建 UI**，只负责：
 *   1. 绑定已有节点（按路径查找）
 *   2. 用配置数据填充卡片文案 / 在线人数
 *   3. 绑定按钮点击 → 进入房间
 *
 * 层级结构（可在编辑器层级管理器中看到）：
 *   Scene
 *    └─ Canvas                       [cc.Canvas, cc.UITransform, cc.Widget]
 *        ├─ Bg                       [cc.Graphics]
 *        ├─ Header                   [cc.Graphics]
 *        │   ├─ HeaderTitle          [cc.Label]
 *        │   └─ HeaderUser           [cc.Label]
 *        ├─ GameList                 [cc.ScrollView]
 *        │   └─ view                 [cc.Mask]
 *        │       └─ content          [cc.Layout]
 *        │           ├─ Card_planehunt [cc.Graphics]
 *        │           │   ├─ Icon / IconText / Name / Desc / Online
 *        │           │   └─ PlayBtn   [cc.Button] → PlayBtnLabel
 *        │           └─ Card_gomoku  ...
 *        ├─ Footer                   [cc.Label]
 *        ├─ SceneRoot                [LobbyScene]   ← 本脚本
 *        └─ Camera                   [cc.Camera]
 */

import { _decorator, Component, Label, Node } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { GameMeta, getSortedGameList } from '../config/GameList';
import { services, ensureServices } from '../core/ServiceLocator';
import { uiManager } from '../core/UIManager';
import { bindClick, fillAt, findNode, requireNode, setLabelText } from '../core/UIFactory';
import { portraitAdapter } from '../core/PortraitAdapter';
import { isGameRegistered } from '../games/common/GameRegistry';

const { ccclass } = _decorator;

@ccclass('LobbyScene')
export class LobbyScene extends Component {
    /** 卡片节点列表，用于显示在线人数。 */
    private readonly _onlineLabels = new Map<string, Label>();

    protected onLoad(): void {
        ensureServices();
        // 竖版自适应：按机型重算设计分辨率 + 贴边条安全区避让（见 core/PortraitAdapter.ts）
        portraitAdapter.apply();
        portraitAdapter.applyEdgeInsets(this.node);
        this._bindNodes();
        void this._loadOnlineCount();
    }

    /**
     * 绑定静态场景节点 + 用配置数据填充。
     *
     * 卡片是静态生成的（Card_<gameId>），这里只覆盖动态文案与交互。
     */
    private _bindNodes(): void {
        // 用户信息
        const user = services.auth.getCachedUser();
        const userName = user ? user.nickname : '未登录';
        setLabelText(this.node, 'Canvas/Header/HeaderUser', `👤 ${userName}`);

        // 底部说明：数据来源随运行模式变化。
        // 原先写死「数据来源：Mock 通道」，切到真机（USE_MOCK=false）后就成了误导。
        const dataSource = AppConfig.USE_MOCK ? 'Mock 通道' : '微信云开发';
        setLabelText(
            this.node,
            'Canvas/Footer/FooterText',
            `MVP：寻机头 · 五子棋  |  数据来源：${dataSource}`,
        );

        const games = getSortedGameList();
        console.log(`[LobbyScene] 绑定游戏列表：${games.length} 款`);

        for (const meta of games) {
            const cardPath = `Canvas/GameList/view/content/Card_${meta.id}`;
            const card = findNode(this.node, cardPath);
            if (!card) {
                console.warn(`[LobbyScene] 缺少卡片节点 ${cardPath}（请检查 tools/ui-trees.js）`);
                continue;
            }

            // 用配置覆盖静态占位文案，并按配置改图标底色（GameList.iconColor 是唯一来源）
            setLabelText(this.node, `${cardPath}/Icon/IconText`, meta.iconText);
            fillAt(this.node, `${cardPath}/Icon`)?.setFillHex(meta.iconColor);
            setLabelText(this.node, `${cardPath}/Name`, meta.name);
            setLabelText(this.node, `${cardPath}/Desc`, meta.desc);

            // 在线人数占位（稍后 Mock 刷新）
            setLabelText(this.node, `${cardPath}/Online`, '在线 --');
            const onlineNode = findNode(this.node, `${cardPath}/Online`);
            const onlineLabel = onlineNode ? onlineNode.getComponent(Label) : null;
            if (onlineLabel) {
                this._onlineLabels.set(meta.id, onlineLabel);
            }

            // 按钮交互
            const enabled = meta.enabled && isGameRegistered(meta.id);
            const btnNode = findNode(this.node, `${cardPath}/PlayBtn`);
            if (!btnNode) {
                console.warn(`[LobbyScene] 缺少按钮节点 ${cardPath}/PlayBtn`);
                continue;
            }
            if (enabled) {
                bindClick(this.node, `${cardPath}/PlayBtn`, () => this._onGameSelected(meta));
            } else {
                setLabelText(this.node, `${cardPath}/PlayBtn/PlayBtnLabel`, '暂未开放');
                bindClick(this.node, `${cardPath}/PlayBtn`, () =>
                    uiManager.toast('该游戏暂未开放', undefined),
                );
            }
        }

        // 兜底：确保 content 存在（ScrollView 的 content 引用否则为空）
        requireNode(this.node, 'Canvas/GameList/view/content');
    }

    /** 选择游戏后，显示模式选择（创建房间 / 加入房间 / AI 练习）。 */
    private _onGameSelected(meta: GameMeta): void {
        console.log(`[LobbyScene] 选择游戏：${meta.name}`);
        this._showModeDialog(meta);
    }

    /**
     * 模式选择弹窗（规格：入口三选一）。
     *
     * ⚠️ 这是**唯一的运行时 UI**：弹窗内容随所选游戏变化，
     * 不适合静态化。定位为临时浮层，不进层级管理器的场景树常态。
     */
    private _showModeDialog(meta: GameMeta): void {
        uiManager.showChoiceDialog({
            title: meta.name,
            subtitle: '选择游戏方式',
            choices: [
                {
                    label: '创建房间（联机对战）',
                    onPick: () => {
                        console.log('[LobbyScene] 选择「创建房间」→ gotoRoom(pvp)');
                        uiManager.gotoRoom({
                            gameId: meta.id,
                            mode: 'pvp',
                            aiLevel: AppConfig.DEFAULT_AI_LEVEL,
                        });
                    },
                },
                {
                    label: '加入房间',
                    onPick: () => this._showJoinInput(meta),
                },
                {
                    label: 'AI 练习（无需等待）',
                    onPick: () => {
                        console.log('[LobbyScene] 选择「AI 练习」→ gotoRoom(ai)');
                        uiManager.gotoRoom({
                            gameId: meta.id,
                            mode: 'ai',
                            aiLevel: AppConfig.DEFAULT_AI_LEVEL,
                        });
                    },
                },
            ],
        });
    }

    /**
     * 加入房间输入（简化版：提供随机房间号 + 说明）。
     *
     * 说明：第一阶段不引入 EditBox 依赖系统输入法的复杂交互，
     * 提供「示例房间号直进」体验，验证完整入房链路。
     * 第二阶段可替换为 EditBox 数字键盘。
     */
    private _showJoinInput(meta: GameMeta): void {
        const roomId = this._randomRoomId();
        console.log(`[LobbyScene] 模拟输入房间号：${roomId}`);
        uiManager.toast(`加入房间 ${roomId}`, undefined);
        uiManager.gotoRoom({
            gameId: meta.id,
            mode: 'pvp',
            aiLevel: AppConfig.DEFAULT_AI_LEVEL,
            joinRoomId: roomId,
        });
    }

    private _randomRoomId(): string {
        return String(100000 + Math.floor(Math.random() * 899999));
    }

    /** 模拟在线人数（Mock 返回模拟值，第二阶段由云函数返回）。 */
    private async _loadOnlineCount(): Promise<void> {
        await new Promise((r) => setTimeout(r, 300));
        for (const [, label] of this._onlineLabels) {
            const n =
                AppConfig.MOCK_ONLINE_MIN +
                Math.floor(Math.random() * (AppConfig.MOCK_ONLINE_MAX - AppConfig.MOCK_ONLINE_MIN));
            label.string = `在线 ${n.toLocaleString()} 人`;
        }
        console.log('[LobbyScene] 在线人数已刷新（Mock 模拟值）');
    }

    /** 供调试：当前可见卡片数量。 */
    public getCardCount(): number {
        const content = findNode(this.node, 'Canvas/GameList/view/content');
        return content ? content.children.length : 0;
    }
}
