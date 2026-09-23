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
import { newUINode } from '../../core/UIFactory';
import { BoardBase } from '../common/BoardBase';
import { CELL_BODY, CELL_HEAD } from './PlaneHuntLayout';

const { ccclass } = _decorator;

/** 配色：浅色扁平棋盘（取自设计令牌 BOARD，与页面白底同调）。 */
const COLOR_BG = hexToColor(BOARD.huntBg);
/** 网格线 **与外框同色**（两盘统一取自 BOARD.boardLine） */
const COLOR_GRID = hexToColor(BOARD.boardLine);
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
        const { cellSize } = this._layout;
        if (cellSize <= 0) {
            return;
        }

        // 底板 + **加粗外框**（与五子棋共用同一实现 → 线色/线宽完全一致）
        this.drawBoardFrame(g, COLOR_BG, COLOR_GRID);

        // 格子填充（未翻 / 已翻），铺在网格线之下
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

        // 网格线：与五子棋同色同粗（线画在格子边界上，故 spacing = 行列数）
        this.drawGridLines(g, COLOR_GRID, this._cols, cellSize);
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
    /** 已找到的机头数 / 总数（HUD 读取，随权威下发更新）。 */
    private _headsFound = 0;
    private _headTotal = AppConfig.PLANEHUNT_PLANE_COUNT;

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

        // ⚠️ 一律用 newUINode（内部设 UI_2D 层）：new Node() 默认 DEFAULT 层，
        //    相机看不见、点击也没有命中测试 —— 症状是「点棋盘没反应」。
        this._gfxNode = newUINode('GridGfx');
        this.node.addChild(this._gfxNode);
        this._gfxNode.addComponent(UITransform);
        this._gfxNode.addComponent(Graphics);

        this._markLayer = newUINode('MarkLayer');
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
     * @param byMe true = 这一格是我翻的（用于得分/翻格数归属）
     * @param scored 是否翻中机头
     * @param score 该玩家累计得分
     */
    public revealCell(
        row: number,
        col: number,
        cell: number,
        byMe: boolean,
        scored: boolean,
        score: number,
    ): void {
        this._renderer.setRevealed(row, col, cell);
        this._renderer.draw();

        // 翻牌动画：缩放 + 标记
        const pos = this._renderer.cellToLocal(row, col);
        const layout = this._renderer.getLayout();
        const mark = newUINode(`mark_${row}_${col}`);
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

        // 统计归属：必须按「谁翻的」判定，而不是按「翻完后轮到谁」。
        // 曾经的写法用 this._isMyTurn（回合状态，在 setTurn 之后已被切成对手），
        // 会把对手翻到的机头算到我方头上，双方得分整体错位。
        if (byMe) {
            this._myFlips++;
            this._myScore = score;
        } else {
            this._oppFlips++;
            this._oppScore = score;
        }
        void scored;
    }

    /** 更新回合状态与进度（由 Game 驱动）。 */
    public setTurn(isMyTurn: boolean, headsFound: number, headTotal: number): void {
        this._isMyTurn = isMyTurn;
        this._headsFound = headsFound;
        this._headTotal = headTotal;
        this.setInputEnabled(isMyTurn);
        if (AppConfig.LOG_VERBOSE) {
            console.log(`[PlaneHuntBoard] 回合更新 我方=${isMyTurn} 机头进度=${headsFound}/${headTotal}`);
        }
    }

    /** 已找到的机头数（HUD 显示进度用）。 */
    public getHeadsFound(): number {
        return this._headsFound;
    }

    /** 机头总数（HUD 显示进度用）。 */
    public getHeadTotal(): number {
        return this._headTotal;
    }

    /**
     * 翻中机头的得分提示。
     *
     * 注意：文案**不能**再写「再翻一次」—— 当前规则是翻到机头也换手
     * （见 PlaneHuntRules 文件头）。这里只表达「得分 +1」。
     */
    public showScoreTip(): void {
        const node = newUINode('scoreTip');
        this.node.addChild(node);
        node.addComponent(UITransform);
        const label = node.addComponent(Label);
        label.string = '机头！+1 分';
        label.fontSize = 34;
        label.color = COLOR_HEAD;
        node.setPosition(new Vec3(0, 0, 0));
        tween(node)
            .to(0.5, { position: new Vec3(0, 80, 0) })
            .call(() => node.destroy())
            .start();
    }

    /**
     * 显示/隐藏「对手思考中」（与五子棋统一走 BoardBase 的共用遮罩）。
     *
     * 原先这里只打日志、**什么都不显示** —— 寻机头等待对手时界面毫无反馈，
     * 玩家会以为点漏了。现在与五子棋一致：半透明蒙层 + 居中胶囊，
     * 并禁用棋盘输入（防止等待期间误点发出越权请求）。
     */
    public showThinking(show: boolean): void {
        this._renderer.showThinking(show);
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
