/**
 * 寻机头棋盘视图（Cocos 组件）。
 *
 * 表现层职责：
 * - 12×12 格子网格，撑满安全区宽度，格子近正方形；
 * - 翻牌动画、机头高亮（金色）、机身显示（蓝色）
 * - 双方得分实时更新（由 GameScene 的 HUD 负责，本组件只负责棋盘）
 * - 可点击区域 ≥ 44pt
 *
 * 逻辑状态以权威下发为准（客户端不知道布局）。
 */

import {
    _decorator,
    Component,
    EventTouch,
    Graphics,
    Label,
    Node,
    tween,
    UITransform,
    Vec3,
    Color,
} from 'cc';
import { AppConfig } from '../../config/AppConfig';
import { BOARD, hexToColor } from '../../config/UITheme';
import { BoardBase } from '../common/BoardBase';
import { CELL_BODY, CELL_HEAD } from './PlaneHuntLayout';

const { ccclass } = _decorator;

/** 配色：浅色扁平棋盘（取自设计令牌 BOARD，与页面白底同调）。 */
const COLOR_BG = hexToColor(BOARD.huntBg);
const COLOR_GRID = hexToColor(BOARD.huntLine);
const COLOR_CELL_HIDDEN = hexToColor(BOARD.huntHidden);
const COLOR_CELL_EMPTY = hexToColor(BOARD.huntEmpty);
const COLOR_BODY = hexToColor(BOARD.huntBody);
const COLOR_HEAD = hexToColor(BOARD.huntHead);
/** 格子内符号色（机头/机身均为实色底 → 用白色符号保证对比）。 */
const COLOR_MARK = hexToColor(BOARD.huntBg);

/** 棋盘绘制子类。 */
class PlaneHuntRenderer extends BoardBase {
    /** 已揭示状态缓存：index → cell 值 */
    private readonly _revealed = new Map<number, number>();

    constructor() {
        super(AppConfig.PLANEHUNT_SIZE, AppConfig.PLANEHUNT_SIZE);
    }

    /** 记录揭示状态（重绘用）。 */
    public setRevealed(row: number, col: number, cell: number): void {
        this._revealed.set(row * this._cols + col, cell);
    }

    public clearRevealed(): void {
        this._revealed.clear();
    }

    public isRevealed(row: number, col: number): boolean {
        return this._revealed.has(row * this._cols + col);
    }

    public getRevealed(row: number, col: number): number | null {
        return this._revealed.get(row * this._cols + col) ?? null;
    }

    /**
     * 绘制整个棋盘（12×12 方格）。
     *
     * 竖屏自适应：12 列撑满安全区宽度，行高按比例，格子近正方形。
     */
    public draw(): void {
        this.clearGraphics();
        const g = this._gfx;
        if (!g) {
            return;
        }
        const { cellSize, boardWidth, boardHeight } = this._layout;
        if (cellSize <= 0) {
            return;
        }

        // 底板内边距：不许溢出父卡片（白底板外扩会盖掉卡片的 1px 描边）
        const pad = Math.max(0, Math.min(Math.max(4, Math.floor(cellSize * 0.25)), Math.floor(this.innerMargin())));
        // 底板
        this.fillRect(
            g,
            -boardWidth / 2 - pad,
            -boardHeight / 2 - pad,
            boardWidth + pad * 2,
            boardHeight + pad * 2,
            COLOR_BG,
        );

        const inset = Math.max(1, Math.floor(cellSize * 0.06));
        for (let r = 0; r < this._rows; r++) {
            for (let c = 0; c < this._cols; c++) {
                const pos = this.cellToLocal(r, c);
                const size = cellSize - inset * 2;
                const rev = this.getRevealed(r, c);
                let color: Color;
                if (rev === null) {
                    color = COLOR_CELL_HIDDEN;
                } else if (rev === CELL_HEAD) {
                    color = COLOR_HEAD;
                } else if (rev === CELL_BODY) {
                    color = COLOR_BODY;
                } else {
                    color = COLOR_CELL_EMPTY;
                }
                this.fillRect(g, pos.x - size / 2, pos.y - size / 2, size, size, color);
            }
        }

        // 网格线（细边，增强「格子」感）
        g.lineWidth = Math.max(1, Math.floor(cellSize * 0.03));
        g.strokeColor = COLOR_GRID;
        for (let c = 0; c <= this._cols; c++) {
            const x = -boardWidth / 2 + c * cellSize;
            g.moveTo(x, -boardHeight / 2);
            g.lineTo(x, boardHeight / 2);
            g.stroke();
        }
        for (let r = 0; r <= this._rows; r++) {
            const y = -boardHeight / 2 + r * cellSize;
            g.moveTo(-boardWidth / 2, y);
            g.lineTo(boardWidth / 2, y);
            g.stroke();
        }
    }
}

@ccclass('PlaneHuntBoard')
export class PlaneHuntBoard extends Component {
    /** 格子点击回调。 */
    public onCellClick: ((row: number, col: number) => void) | null = null;

    private _inputEnabled = true;
    private _gfxNode: Node | null = null;
    private _markLayer: Node | null = null;
    private readonly _renderer = new PlaneHuntRenderer();

    /** 我方/对手得分与翻格数（HUD 读取）。 */
    private _myScore = 0;
    private _oppScore = 0;
    private _myFlips = 0;
    private _oppFlips = 0;
    private _myPlayerId = '';
    private _firstPlayerId = '';
    private _isMyTurn = false;

    // ==================== 生命周期 ====================

    protected onLoad(): void {
        this._buildTree();
        this.node.on(Node.EventType.TOUCH_END, this._onTouch, this);
    }

    protected onDestroy(): void {
        this.node.off(Node.EventType.TOUCH_END, this._onTouch, this);
    }

    /**
     * 节点树（对应竖屏 UI 结构说明）：
     *   GameScene/BoardArea
     *     └─ PlaneBoardRoot (本组件, 锚点 0.5/0.5)
     *          ├─ GridGfx (Graphics, 12×12 方格)
     *          └─ MarkLayer (机头/机身标记动画)
     */
    private _buildTree(): void {
        let ut = this.node.getComponent(UITransform);
        if (!ut) {
            ut = this.node.addComponent(UITransform);
        }
        ut.setAnchorPoint(0.5, 0.5);

        this._gfxNode = new Node('GridGfx');
        this.node.addChild(this._gfxNode);
        this._gfxNode.addComponent(UITransform);
        this._gfxNode.addComponent(Graphics);

        this._markLayer = new Node('MarkLayer');
        this.node.addChild(this._markLayer);
        this._markLayer.addComponent(UITransform);

        this._renderer.attach(this._gfxNode);
    }

    // ==================== 对外 API ====================

    /** 初始化。 */
    public setup(myPlayerId: string, firstPlayerId: string): void {
        this._myPlayerId = myPlayerId;
        this._firstPlayerId = firstPlayerId;
    }

    /** 绘制空棋盘（对局开始）。 */
    public renderGrid(): void {
        this._renderer.clearRevealed();
        this._renderer.recalculateLayout();
    }

    /**
     * 揭示一格（权威结果下发后调用）。
     *
     * @param scored 是否翻中机头
     * @param score 该玩家累计得分
     */
    public revealCell(row: number, col: number, cell: number, scored: boolean, score: number): void {
        this._renderer.setRevealed(row, col, cell);
        this._renderer.draw();

        // 翻牌动画：缩放 + 标记
        const pos = this._renderer.cellToLocal(row, col);
        const layout = this._renderer.getLayout();
        const mark = new Node(`mark_${row}_${col}`);
        this._markLayer?.addChild(mark);
        mark.setPosition(pos);
        mark.addComponent(UITransform).setContentSize(layout.cellSize, layout.cellSize);

        const label = mark.addComponent(Label);
        label.fontSize = Math.max(14, Math.floor(layout.cellSize * 0.5));
        if (cell === CELL_HEAD) {
            label.string = '✈';
            label.color = COLOR_MARK;
        } else if (cell === CELL_BODY) {
            label.string = '●';
            label.color = COLOR_MARK;
        } else {
            label.string = '';
        }

        mark.setScale(new Vec3(0.3, 0.3, 1));
        tween(mark).to(0.15, { scale: new Vec3(1.05, 1.05, 1) }).to(0.08, { scale: new Vec3(1, 1, 1) }).start();

        // 统计
        const isMine = this._isMyTurn;
        if (isMine) {
            this._myFlips++;
            this._myScore = this._myPlayerId === this._firstPlayerId ? score : score;
        } else {
            this._oppFlips++;
            this._oppScore = score;
        }
        void scored;
    }

    /** 更新回合状态与进度（由 Game 驱动）。 */
    public setTurn(isMyTurn: boolean, headsFound: number, headTotal: number): void {
        this._isMyTurn = isMyTurn;
        this.setInputEnabled(isMyTurn);
        if (AppConfig.LOG_VERBOSE) {
            console.log(`[PlaneHuntBoard] 回合更新 我方=${isMyTurn} 机头进度=${headsFound}/${headTotal}`);
        }
    }

    /** 翻中机头奖励提示。 */
    public showBonusTip(): void {
        const node = new Node('bonusTip');
        this.node.addChild(node);
        node.addComponent(UITransform);
        const label = node.addComponent(Label);
        label.string = '机头！再翻一次';
        label.fontSize = 34;
        label.color = COLOR_HEAD;
        node.setPosition(new Vec3(0, 0, 0));
        tween(node)
            .to(0.5, { position: new Vec3(0, 80, 0) })
            .call(() => node.destroy())
            .start();
    }

    public showThinking(show: boolean): void {
        if (AppConfig.LOG_VERBOSE) {
            console.log(`[PlaneHuntBoard] 对手思考中: ${show}`);
        }
    }

    public setInputEnabled(v: boolean): void {
        this._inputEnabled = v;
        this._renderer.setInteractive(v);
    }

    public getMyScore(): number {
        return this._myScore;
    }

    public getOppScore(): number {
        return this._oppScore;
    }

    public getMyFlips(): number {
        return this._myFlips;
    }

    public getOppFlips(): number {
        return this._oppFlips;
    }

    public describe(): string {
        return this._renderer.describe();
    }

    // ==================== 内部 ====================

    private _onTouch(event: EventTouch): void {
        if (!this._inputEnabled) {
            return;
        }
        const ut = this._gfxNode ? this._gfxNode.getComponent(UITransform) : null;
        if (!ut) {
            return;
        }
        const worldPos = event.getUILocation();
        const local = ut.convertToNodeSpaceAR(new Vec3(worldPos.x, worldPos.y, 0));
        const cell = this._renderer.hitTest(local.x, local.y);
        if (!cell) {
            return;
        }
        if (this._renderer.isRevealed(cell.row, cell.col)) {
            return;
        }
        if (this.onCellClick) {
            this.onCellClick(cell.row, cell.col);
        }
    }
}
