/**
 * UiFill.ts —— 「静态场景色块」自绘组件（扁平 UI 的基础件）。
 *
 * 为什么需要它（本项目最关键的一次根因修复）：
 *   cc.Graphics **只序列化颜色/线宽等参数，不序列化已绘制的路径**。
 *   所以写在 .scene 里的 Graphics 组件（Bg / Header / 卡片底）是「空 Graphics」——
 *   既不在编辑器里画出来，运行时也不画，界面只剩文字（表现为"白板/黑板 + 文字"）。
 *   修复方式：给静态节点挂本组件，把「填充色 / 圆角 / 描边」作为**可序列化属性**
 *   写进 .scene（编辑器 Inspector 里可见可调），onLoad 时自绘。
 *
 * 典型用法（见 tools/ui-trees.js 的 fillNode()）：
 *   - 白底页面：{ fillColor: #FFFFFF, radius: 0 }
 *   - 扁平卡片：{ fillColor: #FFFFFF, radius: 24, borderColor: #E6E8EC, borderWidth: 1 }
 *   - 胶囊标签：{ fillColor: #EAF0FF, radius: 999 }（半径按高的一半夹取）
 */

import { _decorator, Color, Component, Graphics, UITransform } from 'cc';
import { hexToColor } from '../config/UITheme';

const { ccclass, property } = _decorator;

@ccclass('UiFill')
export class UiFill extends Component {
    /** 填充色（alpha = 0 表示不填充）。 */
    @property({ type: Color })
    public fillColor: Color = new Color(255, 255, 255, 255);

    /** 圆角半径（0 = 直角；超过高/宽一半时自动夹取为胶囊）。 */
    @property
    public radius = 0;

    /** 描边色（扁平风格用 1px 细边划分层次；alpha = 0 时不描边）。 */
    @property({ type: Color })
    public borderColor: Color = new Color(0, 0, 0, 0);

    /** 描边粗细。 */
    @property
    public borderWidth = 0;

    /** 是否在 onLoad / onEnable 自动重绘。 */
    @property
    public drawOnLoad = true;

    private _gfx: Graphics | null = null;

    protected onLoad(): void {
        if (this.drawOnLoad) {
            this.redraw();
        }
    }

    protected onEnable(): void {
        // 面板类节点（默认隐藏，如表情面板）首次激活时才需要绘制
        if (this.drawOnLoad) {
            this.redraw();
        }
    }

    // ==================== 绘制 ====================

    /** 按当前尺寸与属性重绘（尺寸变化后需手动调用）。 */
    public redraw(): void {
        const g = this.graphics();
        if (!g) {
            return;
        }
        g.clear();

        const t = this.node.getComponent(UITransform);
        const w = t ? t.width : 0;
        const h = t ? t.height : 0;
        if (w <= 0 || h <= 0) {
            return;
        }

        // 锚点偏移：以节点自身矩形为准作图（兼容 anchor 非 0.5 的节点）
        const ax = t ? t.anchorX : 0.5;
        const ay = t ? t.anchorY : 0.5;
        const x0 = -w * ax;
        const y0 = -h * ay;

        const r = Math.max(0, Math.min(this.radius, Math.min(w, h) / 2));
        const path = (): void => {
            if (r > 0) {
                g.roundRect(x0, y0, w, h, r);
            } else {
                g.rect(x0, y0, w, h);
            }
        };

        if (this.fillColor.a > 0) {
            g.fillColor = this.fillColor;
            path();
            g.fill();
        }
        if (this.borderWidth > 0 && this.borderColor.a > 0) {
            g.lineWidth = this.borderWidth;
            g.strokeColor = this.borderColor;
            path();
            g.stroke();
        }
    }

    // ==================== 运行时改色（座位状态 / 图标色等） ====================

    /** 设置填充色并重绘。 */
    public setFill(color: Color): void {
        this.fillColor = color;
        this.redraw();
    }

    /** 用 hex 设置填充色并重绘（例如 GameList 的 iconColor 配置）。 */
    public setFillHex(hex: string): void {
        this.setFill(hexToColor(hex));
    }

    /** 设置描边（宽 ≤ 0 时取消描边）。 */
    public setBorder(color: Color, width: number): void {
        this.borderColor = color;
        this.borderWidth = width;
        this.redraw();
    }

    /** 取绘图组件（懒创建；同节点已存在 Graphics 时直接复用）。 */
    private graphics(): Graphics | null {
        if (this._gfx && this._gfx.isValid) {
            return this._gfx;
        }
        this._gfx = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
        return this._gfx;
    }
}