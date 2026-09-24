/**
 * 五子棋棋盘视图（Cocos 组件）。
 *
 * 表现层职责：
 * - 木纹背景、网格线、星位、最后一手标记；
 * - 落子动画与音效触发点；
 * - 交叉点热区 ≥ 44pt（竖屏触控规范）。
 *
 * 逻辑层职责（GomokuRules）不在此文件，保证规则可单元测试。
 */

import {
    _decorator,
    Component,
    EventTouch,
    Graphics,
    Label,
    Node,
    Sprite,
    tween,
    UIOpacity,
    UITransform,
    Vec3,
} from 'cc';
import { AppConfig } from '../../config/AppConfig';
import { BOARD, hexToColor } from '../../config/UITheme';
import { newUINode } from '../../core/UIFactory';
import { BoardBase } from '../common/BoardBase';
import { GomokuRules, Stone } from './GomokuRules';

const { ccclass } = _decorator;

/** 棋盘配色（取自设计令牌 BOARD）：暖白底 + 统一中灰线，扁平简约。 */
const COLOR_BG = hexToColor(BOARD.gomokuBg); // 棋盘底（暖灰白）
/** 网格线 **与外框同色**（两盘统一取自 BOARD.boardLine） */
const COLOR_GRID = hexToColor(BOARD.boardLine);
const COLOR_STAR = hexToColor(BOARD.gomokuStar);
const COLOR_BLACK = hexToColor(BOARD.blackStone);
const COLOR_WHITE = hexToColor(BOARD.whiteStone);
const COLOR_STONE_EDGE = hexToColor(BOARD.stoneEdge);
const COLOR_LAST = hexToColor(BOARD.lastMark);
const COLOR_WIN = hexToColor(BOARD.winLine);

/**
 * 棋盘绘制子类：复用 BoardBase 的坐标换算。
 */
class GomokuBoardRenderer extends BoardBase {
    /** 棋盘背景与网格的 Graphics（挂在容器上）。 */
    constructor() {
        super(AppConfig.GOMOKU_SIZE, AppConfig.GOMOKU_SIZE);
    }

    public draw(): void {
        this.clearGraphics();
        const g = this._gfx;
        if (!g) {
            return;
        }
        const { cellSize, boardWidth } = this._layout;
        if (cellSize <= 0) {
            return;
        }

        // 底板 + **加粗外框**（共用实现：线色/线宽与寻机头完全一致）
        this.drawBoardFrame(g, COLOR_BG, COLOR_GRID);

        // 网格线：线宽/颜色统一由 BoardBase 提供，与外框同色
        // 五子棋的线画在**交叉点**上（c=0..14 共 15 条），故 spacing=rows-1
        this.drawGridLines(g, COLOR_GRID, this._cols - 1, cellSize);

        // 星位（15×15 标准 5 个：天元 + 四星）
        const stars: Array<[number, number]> = [
            [3, 3],
            [3, 11],
            [7, 7],
            [11, 3],
            [11, 11],
        ];
        g.fillColor = COLOR_STAR;
        const starR = Math.max(3, Math.floor(cellSize * 0.16));
        for (const [r, c] of stars) {
            const pos = this.cellToLocal(r, c);
            g.circle(pos.x, pos.y, starR);
            g.fill();
        }

        // 交叉点热区提示（调试用，仅在 verbose 下画十字；正式版不画以保持整洁）
    }
}

@ccclass('GomokuBoard')
export class GomokuBoard extends Component {
    /** 落子回调（由 GomokuGame 注入）。 */
    public onCellClick: ((row: number, col: number) => void) | null = null;

    /** 是否启用输入。 */
    private _inputEnabled = true;
    /** 棋盘容器节点（本组件的子节点）。 */
    private _boardNode: Node | null = null;
    /** 棋子层容器。 */
    private _stoneLayer: Node | null = null;
    // 注：原 _thinkingLabel / _thinkingNode 字段已移除 —— 思考提示改由
    // BoardBase.showThinking() 的共用遮罩承担（见该方法的说明）。
    /** 渲染器。 */
    private readonly _renderer = new GomokuBoardRenderer();
    /** 棋子节点缓存：index = row*size+col → Node */
    private readonly _stoneNodes = new Map<number, Node>();
    /** 规则引用（只读渲染用）。 */
    private _rules: GomokuRules | null = null;
    /** 本机 playerId。 */
    private _myPlayerId = '';
    /** 最后一手标记节点。 */
    private _lastMark: Node | null = null;

    // ==================== 生命周期 ====================

    protected onLoad(): void {
        this._buildTree();
        this.node.on(Node.EventType.TOUCH_END, this._onTouch, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_END, this._onTouch, this);
        this._stoneNodes.clear();
    }

    /**
     * 构建节点树。
     *
     * 竖屏布局说明（对应「各场景竖屏 UI 节点结构说明」）：
     *   GameScene/BoardArea (安全区内)
     *     └─ BoardRoot (本组件, 锚点 0.5/0.5, 居中对齐)
     *          ├─ BoardGfx  (Graphics, 木纹+网格+星位)
     *          ├─ StoneLayer (空节点, 棋子与标记都挂这里, 保证渲染层级高于网格)
     *          └─ Thinking  (Label, 对手思考提示, 默认隐藏)
     */
    private _buildTree(): void {
        const t = this.node.getComponent(UITransform);
        if (!t) {
            this.node.addComponent(UITransform);
        }
        const ut = this.node.getComponent(UITransform);
        if (ut) {
            // 锚点居中，便于居中对齐与坐标换算
            ut.setAnchorPoint(0.5, 0.5);
        }

        // 棋盘图形层
        // ⚠️ 一律用 newUINode（内部设 UI_2D 层）：new Node() 默认 DEFAULT 层，
        //    相机看不见、点击也没有命中测试 —— 症状是「点棋盘没反应」。
        this._boardNode = newUINode('BoardGfx');
        this.node.addChild(this._boardNode);
        this._boardNode.addComponent(UITransform);
        this._boardNode.addComponent(Graphics);

        // 棋子层（独立节点，保证绘制顺序在网格之上）
        this._stoneLayer = newUINode('StoneLayer');
        this.node.addChild(this._stoneLayer);
        this._stoneLayer.addComponent(UITransform);

        // 思考提示：已改为 BoardBase 的共用遮罩（半透明蒙层 + 居中胶囊），
        // 由 _renderer.showThinking() 懒建在棋盘容器上 —— 这里不再建裸 Label。
        // （原先那行裸文字压在棋盘网格上，视觉突兀且挡不住点击。）

        // 绑定渲染器
        this._renderer.attach(this._boardNode);
    }

    // ==================== 对外 API ====================

    /** 初始化棋盘（注入规则）。 */
    public setup(rules: GomokuRules, myPlayerId: string): void {
        this._rules = rules;
        this._myPlayerId = myPlayerId;
        this._renderer.recalculateLayout();
    }

    /** 全量重绘（重开一局/重连补发后调用）。 */
    public renderAll(): void {
        // 清空旧棋子
        if (this._stoneLayer) {
            this._stoneLayer.removeAllChildren();
        }
        this._stoneNodes.clear();
        this._renderer.draw();

        const rules = this._rules;
        if (!rules) {
            return;
        }
        for (const m of rules.history) {
            this._drawStone(m.row, m.col, m.stone, false);
        }
        if (rules.winLine.length > 0) {
            this._drawWinLine(rules.winLine);
        }
    }

    /**
     * 落子渲染（含音效触发点与缩放动画）。
     */
    public placeStone(row: number, col: number, stone: Stone, winLine: Array<{ row: number; col: number }> = []): void {
        const node = this._drawStone(row, col, stone, true);
        if (node) {
            // 落子动画：由小放大，形成「啪」的视觉反馈
            node.setScale(new Vec3(0.2, 0.2, 1));
            tween(node).to(0.12, { scale: new Vec3(1, 1, 1) }).start();
        }
        // TODO(wechat-phase2): 音效接入 —— 经 IPlatformService 无关，
        //   建议用 AudioSource 播放落子音（资源见 assets/audio/）。
        //   验证方法：真机落子能听到声音。

        if (winLine.length > 0) {
            this._drawWinLine(winLine);
        }
        this._markLast(row, col);
    }

    /** 设置输入开关（非本方回合禁用）。 */
    public setInputEnabled(v: boolean): void {
        this._inputEnabled = v;
        this._renderer.setInteractive(v);
    }

    /**
     * 摘掉一颗棋子（预落子回滚用，见 GomokuGame._rollbackLocal）。
     * 同时清掉「最后一手」标记 —— 回滚后那枚红点若留在原地，会指向一个空格。
     */
    public removeStone(row: number, col: number): void {
        const idx = row * this._renderer.getSize().cols + col;
        const node = this._stoneNodes.get(idx);
        if (node) {
            node.destroy();
            this._stoneNodes.delete(idx);
        }
        if (this._lastMark) {
            this._lastMark.destroy();
            this._lastMark = null;
        }
    }

    /**
     * 显示/隐藏「对手思考中」。
     *
     * 实现已上移到共用基类 BoardBase（半透明蒙层 + 居中胶囊，并顺带禁用棋盘输入）——
     * 原先这里是一行裸 Label 直接压在棋盘网格上，视觉突兀且挡不住点击。
     * 保留本方法作为薄转发，是为了不动 GomokuGame 里的调用点。
     */
    public showThinking(show: boolean): void {
        this._renderer.showThinking(show);
    }

    /** 棋盘布局描述（调试）。 */
    public describe(): string {
        return this._renderer.describe();
    }

    /**
     * 公开补画获胜连线（预落子的制胜一手：假子先落，权威帧到达后补高亮）。
     * 内部幂等：同一条线重复调用会叠出多个 winLine 节点 —— 调用方保证只画一次。
     */
    public drawWinLine(line: Array<{ row: number; col: number }>): void {
        this._drawWinLine(line);
    }

    // ==================== 内部 ====================

    /**
     * 触摸处理：把屏幕坐标换算成格子坐标并回调。
     *
     * 关键点：使用 UITransform.convertToNodeSpaceAR 得到相对锚点的本地坐标，
     * 再交给 BoardBase.hitTest 换算行列，避免直接用 worldPosition 导致偏移。
     */
    private _onTouch(event: EventTouch): void {
        if (!this._inputEnabled) {
            return;
        }
        const uiTransform = this._boardNode ? this._boardNode.getComponent(UITransform) : null;
        if (!uiTransform) {
            return;
        }
        const worldPos = event.getUILocation();
        const local = uiTransform.convertToNodeSpaceAR(new Vec3(worldPos.x, worldPos.y, 0));
        const cell = this._renderer.hitTest(local.x, local.y);
        if (!cell) {
            return;
        }
        if (this.onCellClick) {
            this.onCellClick(cell.row, cell.col);
        }
    }

    /** 绘制一个棋子。 */
    private _drawStone(row: number, col: number, stone: Stone, animate: boolean): Node | null {
        if (!this._stoneLayer) {
            return null;
        }
        const idx = row * this._renderer.getSize().cols + col;
        if (this._stoneNodes.has(idx)) {
            return this._stoneNodes.get(idx) ?? null;
        }

        const layout = this._renderer.getLayout();
        const pos = this._renderer.cellToLocal(row, col);

        const node = newUINode(`stone_${row}_${col}`);
        this._stoneLayer.addChild(node);
        node.setPosition(pos);

        const ut = node.addComponent(UITransform);
        const size = Math.floor(layout.cellSize * 0.86);
        ut.setContentSize(size, size);

        const g = node.addComponent(Graphics);
        const r = size / 2;

        // 黑子：实心 + 同色描边（描边让边缘更「实」，避免抗锯齿发灰）
        // 白子：纯白实心 + **明显加深的描边** —— 白子与棋盘底（暖灰白）靠
        // 描边拉开边界，描边太细/太浅时白子会「糊」进棋盘看不见。
        g.fillColor = stone === 1 ? COLOR_BLACK : COLOR_WHITE;
        g.circle(0, 0, r);
        g.fill();

        if (stone === 2) {
            // 描边宽度按棋子尺寸取 8%，并保证至少 2px（1px 在深色描边上太弱）
            g.lineWidth = Math.max(2, Math.floor(size * 0.08));
            g.strokeColor = COLOR_STONE_EDGE;
            g.circle(0, 0, r);
            g.stroke();
        } else {
            // 黑子也给一圈同色描边，形状更饱满
            g.lineWidth = Math.max(1, Math.floor(size * 0.05));
            g.strokeColor = COLOR_BLACK;
            g.circle(0, 0, r);
            g.stroke();
        }

        this._stoneNodes.set(idx, node);
        void animate;
        return node;
    }

    /** 最后一手标记（红点）。 */
    private _markLast(row: number, col: number): void {
        if (!this._stoneLayer) {
            return;
        }
        if (this._lastMark) {
            this._lastMark.destroy();
            this._lastMark = null;
        }
        const layout = this._renderer.getLayout();
        const node = newUINode('lastMark');
        this._stoneLayer.addChild(node);
        node.setPosition(this._renderer.cellToLocal(row, col));
        node.addComponent(UITransform).setContentSize(layout.cellSize, layout.cellSize);
        const g = node.addComponent(Graphics);
        g.fillColor = COLOR_LAST;
        g.circle(0, 0, Math.max(3, Math.floor(layout.cellSize * 0.16)));
        g.fill();
        this._lastMark = node;
    }

    /** 获胜连线高亮。 */
    private _drawWinLine(line: Array<{ row: number; col: number }>): void {
        if (!this._stoneLayer || line.length === 0) {
            return;
        }
        const layout = this._renderer.getLayout();
        const node = newUINode('winLine');
        this._stoneLayer.addChild(node);
        node.addComponent(UITransform);
        const g = node.addComponent(Graphics);
        g.lineWidth = Math.max(3, Math.floor(layout.cellSize * 0.16));
        g.strokeColor = COLOR_WIN;

        const first = line[0];
        const last = line[line.length - 1];
        const p1 = this._renderer.cellToLocal(first.row, first.col);
        const p2 = this._renderer.cellToLocal(last.row, last.col);
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.stroke();

        // 高亮获胜棋子
        for (const p of line) {
            const idx = p.row * this._renderer.getSize().cols + p.col;
            const stone = this._stoneNodes.get(idx);
            if (stone) {
                const op = stone.getComponent(UIOpacity) ?? stone.addComponent(UIOpacity);
                tween(op).to(0.3, { opacity: 140 }).to(0.3, { opacity: 255 }).union().repeatForever().start();
            }
        }
    }
}

/** 未使用引用占位，保持 Sprite 导入可用（美术替换时使用）。 */
export type __SpriteRef = typeof Sprite;
