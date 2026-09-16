/**
 * 棋盘交互与渲染基类（两款游戏共用）。
 *
 * 职责：
 * - 竖屏自适应：按安全区可用宽度计算格子尺寸，保证热区 ≥ 44pt；
 * - 统一触摸→格子坐标换算；
 * - 统一绘制容器与坐标换算（不改动节点树结构，便于美术替换）。
 *
 * 表现层与逻辑层分离：本类只负责「像素 ↔ 格坐标」与视觉元素容器，
 * 规则判定一律由各游戏的纯逻辑类完成。
 */

import { Color, Graphics, Node, UITransform, Vec3, view } from 'cc';
import { AppConfig } from '../../config/AppConfig';

/** 棋盘布局计算结果。 */
export interface BoardLayout {
    /** 每格边长（px，设计分辨率坐标系） */
    cellSize: number;
    /** 棋盘总宽 */
    boardWidth: number;
    /** 棋盘总高 */
    boardHeight: number;
    /** 棋盘中心相对父节点的偏移（居中用） */
    offsetX: number;
    offsetY: number;
}

/**
 * 棋盘基类：提供坐标换算 + 自适应尺寸计算。
 *
 * 子类实现 draw() 完成具体绘制（五子棋画网格线，寻机头画方格）。
 */
export abstract class BoardBase {
    /** 棋盘行列数。 */
    protected readonly _rows: number;
    protected readonly _cols: number;
    /** 绘制容器节点（由场景注入）。 */
    protected _root: Node | null = null;
    /** 图形绘制组件（统一用一个 Graphics 绘制底纹与线条，减少 drawcall）。 */
    protected _gfx: Graphics | null = null;
    protected _layout: BoardLayout;
    /** 交互是否启用（非自己回合时禁止点击）。 */
    protected _interactive = true;

    constructor(rows: number, cols: number) {
        this._rows = rows;
        this._cols = cols;
        this._layout = {
            cellSize: 0,
            boardWidth: 0,
            boardHeight: 0,
            offsetX: 0,
            offsetY: 0,
        };
    }

    /** 绑定渲染容器并计算布局。 */
    public attach(root: Node): void {
        this._root = root;
        this._gfx = root.getComponent(Graphics);
        if (!this._gfx) {
            this._gfx = root.addComponent(Graphics);
        }
        this.recalculateLayout();
    }

    /**
     * 重新计算自适应布局。
     *
     * 竖屏规则：
     * - 12/15 列撑满安全区可用宽度；
     * - 格子接近正方形，但受可用高度约束；
     * - 格子边长不低于 AppConfig.MIN_TOUCH_SIZE 的一半（热区通过放大节点补足）。
     */
    public recalculateLayout(): void {
        if (!this._root) {
            return;
        }

        // 以父节点（棋盘容器）的实际尺寸为准，容器尺寸已由场景按安全区算好
        const parentTransform = this._root.parent ? this._root.parent.getComponent(UITransform) : null;
        const availW = parentTransform ? parentTransform.width : AppConfig.DESIGN_WIDTH - 40;
        const availH = parentTransform ? parentTransform.height : AppConfig.DESIGN_HEIGHT * 0.6;

        // 按列数撑满宽度
        let cell = availW / this._cols;
        // 若高度不够则按高度收缩，保证完整可见
        if (cell * this._rows > availH) {
            cell = availH / this._rows;
        }
        cell = Math.floor(cell);

        const boardWidth = cell * this._cols;
        const boardHeight = cell * this._rows;

        this._layout = {
            cellSize: cell,
            boardWidth,
            boardHeight,
            // 容器锚点设为 (0.5, 0.5)，棋盘自身居中
            offsetX: 0,
            offsetY: 0,
        };

        const t = this._root.getComponent(UITransform);
        if (t) {
            t.setContentSize(boardWidth, boardHeight);
        }

        this._onLayoutChanged();
    }

    /** 布局变化钩子（子类重绘）。 */
    protected _onLayoutChanged(): void {
        this.draw();
    }

    /** 子类实现：绘制棋盘底纹与线条。 */
    public abstract draw(): void;

    /**
     * 触摸点 → 格子坐标。
     *
     * @param localX 相对于棋盘容器锚点中心的本地坐标
     * @param localY 同上
     * @returns [row, col]；越界返回 null
     */
    public hitTest(localX: number, localY: number): { row: number; col: number } | null {
        const { cellSize, boardWidth, boardHeight } = this._layout;
        if (cellSize <= 0) {
            return null;
        }
        // 容器锚点 (0.5, 0.5)，故左上角为 (-w/2, +h/2)
        const left = -boardWidth / 2;
        const top = boardHeight / 2;

        const col = Math.floor((localX - left) / cellSize);
        // Y 轴向上为正，行号从上往下
        const row = Math.floor((top - localY) / cellSize);

        if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) {
            return null;
        }
        return { row, col };
    }

    /**
     * 格子中心 → 相对容器中心的本地坐标。
     * @returns 可直接赋给子节点 position 的 Vec3
     */
    public cellToLocal(row: number, col: number): Vec3 {
        const { cellSize, boardWidth, boardHeight } = this._layout;
        const left = -boardWidth / 2;
        const top = boardHeight / 2;
        const x = left + (col + 0.5) * cellSize;
        const y = top - (row + 0.5) * cellSize;
        return new Vec3(x, y, 0);
    }

    /** 当前布局（只读）。 */
    public getLayout(): BoardLayout {
        return this._layout;
    }

    /** 行列数。 */
    public getSize(): { rows: number; cols: number } {
        return { rows: this._rows, cols: this._cols };
    }

    /** 设置交互开关（非本方回合禁用点击）。 */
    public setInteractive(v: boolean): void {
        this._interactive = v;
        this._onInteractiveChanged(v);
    }

    /** 交互开关变化钩子。 */
    protected _onInteractiveChanged(_v: boolean): void {
        // 默认无操作，子类可覆盖（如变暗棋盘）
    }

    public isInteractive(): boolean {
        return this._interactive;
    }

    /** 清空绘制（重开一局）。 */
    protected clearGraphics(): void {
        if (this._gfx) {
            this._gfx.clear();
        }
    }

    // ==================== 棋盘外框 / 线条（两盘共用，保证观感一致） ====================

    /**
     * 棋盘的**统一线宽**（网格线 / 外框共用同一个基准，避免两盘粗细不一）。
     *
     * 为什么要有这个函数：线条粗细原先在各棋盘里各写一份
     * （五子棋 5%、寻机头 3%），结果两款游戏的棋盘观感明显不一致。
     * 现在统一从这里取，改一处两盘同步。
     */
    protected gridLineWidth(): number {
        const cell = this._layout.cellSize;
        // 以格子尺寸为基准，夹在 [1, 3]：太细看不见，太粗会糊住格子
        return Math.max(1, Math.min(3, Math.floor(cell * 0.06)));
    }

    /** 外框线宽 = 网格线的 3 倍（至少 4px），用于强化棋盘「存在感」。 */
    protected borderLineWidth(): number {
        return Math.max(4, this.gridLineWidth() * 3);
    }

    /** 棋盘底板外扩的内边距（外框与网格之间留出的边距）。 */
    protected boardPad(): number {
        const cell = this._layout.cellSize;
        return Math.max(0, Math.min(Math.max(6, Math.floor(cell * 0.3)), Math.floor(this.innerMargin())));
    }

    /**
     * 绘制棋盘底板 + **加粗外框**。
     *
     * 外框单独用更粗的线画在网格外侧，是「让棋盘看起来是一块板」的关键：
     * 只有细网格线时，棋盘会「浮」在页面上、边界糊掉。
     *
     * @param bgColor 底板填充色
     * @param lineColor 网格线与外框统一的颜色
     */
    protected drawBoardFrame(g: Graphics, bgColor: Color, lineColor: Color): void {
        const { boardWidth, boardHeight } = this._layout;
        if (boardWidth <= 0 || boardHeight <= 0) {
            return;
        }
        const pad = this.boardPad();

        // 1) 底板（含外扩边距）
        this.fillRect(
            g,
            -boardWidth / 2 - pad,
            -boardHeight / 2 - pad,
            boardWidth + pad * 2,
            boardHeight + pad * 2,
            bgColor,
        );

        // 2) 加粗外框：贴着底板外沿画，线心内缩半个线宽避免被裁掉
        const bw = this.borderLineWidth();
        const half = bw / 2;
        g.lineWidth = bw;
        g.strokeColor = lineColor;
        g.rect(
            -boardWidth / 2 - pad + half,
            -boardHeight / 2 - pad + half,
            boardWidth + pad * 2 - bw,
            boardHeight + pad * 2 - bw,
        );
        g.stroke();
    }

    /** 统一线宽的网格线绘制（竖线 + 横线），颜色与外框一致。 */
    protected drawGridLines(g: Graphics, lineColor: Color, spacing: number, offset: number): void {
        const { boardWidth, boardHeight } = this._layout;
        g.lineWidth = this.gridLineWidth();
        g.strokeColor = lineColor;
        const half = boardWidth / 2;
        const halfH = boardHeight / 2;
        for (let i = 0; i <= spacing; i++) {
            const x = -half + i * offset;
            g.moveTo(x, -halfH);
            g.lineTo(x, halfH);
            g.stroke();
            const y = -halfH + i * offset;
            g.moveTo(-half, y);
            g.lineTo(half, y);
            g.stroke();
        }
    }

    /**
     * 棋盘底板的可用内边距上限。
     *
     * 棋盘底板（background）会外扩 pad 绘制，但**不能超出父级卡片** ——
     * 白底扁平风格下卡片有 1px 描边，白底板一旦外扩就会把描边盖出缺口。
     * 由于 cellSize = floor(父宽/列数)，父宽与本节点宽之差的一半就是天然余量。
     */
    protected innerMargin(): number {
        if (!this._root) {
            return 0;
        }
        const t = this._root.getComponent(UITransform);
        const parent = this._root.parent ? this._root.parent.getComponent(UITransform) : null;
        const bw = t ? t.width : 0;
        const pw = parent ? parent.width : bw;
        return Math.max(0, (pw - bw) / 2);
    }

    /** 便捷：绘制实心矩形。 */
    protected fillRect(g: Graphics, x: number, y: number, w: number, h: number, color: Color): void {
        g.fillColor = color;
        g.rect(x, y, w, h);
        g.fill();
    }

    /**
     * 计算当前棋盘在屏幕上的可见性（用于调试日志）。
     */
    public describe(): string {
        const { cellSize, boardWidth, boardHeight } = this._layout;
        return `棋盘 ${this._rows}x${this._cols} 格=${cellSize}px 尺寸=${boardWidth}x${boardHeight} 可见=${view.getVisibleSize().width}x${view.getVisibleSize().height}`;
    }
}
