/**
 * UI 工具集：程序化创建 UI 节点（无需预制体/美术资源即可跑通）。
 *
 * 设计系统（白底 + 扁平简约）见 `assets/scripts/config/UITheme.ts` 与 docs/UI_DESIGN.md。
 * 本文件只负责「把令牌变成节点」，**不写死任何颜色**：
 *   · 颜色一律取 THEME.*（由 UITheme.ts 的 PALETTE 派生）
 *   · 圆角/间距/字号取 RADIUS / SPACE / FONT / LAYOUT
 *
 * 两类 UI 的分工（重要）：
 *   1. **静态 UI**（页面骨架：Bg / Header / 卡片 / 按钮）→ 写在 .scene 里，
 *      由 tools/ui-trees.js 生成；色块用 `assets/scripts/core/UiFill.ts`（自绘组件）。
 *      控制器**只按路径绑定**，不要用本文件的 createXxx 重建（会重复两套 UI）。
 *   2. **运行时浮层**（Toast / 模式选择 / 结算弹窗）→ 内容随数据变化，才用本文件构建。
 */

import {
    Button,
    Color,
    Graphics,
    Label,
    Layout,
    Node,
    Sprite,
    UIOpacity,
    UITransform,
    Vec2,
    Vec3,
    Widget,
} from 'cc';
import { AppConfig } from '../config/AppConfig';
import { FONT, LAYOUT, RADIUS, THEME, hexToColor } from '../config/UITheme';
import { UiFill } from './UiFill';

// 主题与工具转发（历史代码从本文件 import THEME/hexToColor，保持兼容；唯一实现在 UITheme.ts）
export { THEME, hexToColor };

/** 扁平按钮样式（见 docs/UI_DESIGN.md 的按钮规范）。 */
export interface ButtonStyle {
    /** 填充色（默认主色实心） */
    fill?: Color;
    /** 文字色（默认主色上的白色） */
    textColor?: Color;
    /** 描边色（扁平次按钮用 1px 描边代替投影） */
    border?: Color;
    /** 字号 */
    fontSize?: number;
    /** 圆角 */
    radius?: number;
}

/** 圆角夹取（避免 roundRect 半径超过半宽/半高导致图形错乱）。 */
function clampRadius(radius: number, w: number, h: number): number {
    return Math.max(0, Math.min(radius, Math.min(w, h) / 2));
}

/**
 * 创建一个扁平色块矩形节点（替代 Sprite 九宫格，零资源依赖）。
 *
 * @param radius 圆角（0 = 直角；过大自动夹取为胶囊）
 * @param border 可选 1px 描边（扁平风格用它划分层次，而不是投影）
 */
export function createRect(
    name: string,
    width: number,
    height: number,
    color: Color,
    radius = 0,
    border?: { color: Color; width?: number },
): Node {
    const node = new Node(name);
    const t = node.addComponent(UITransform);
    t.setContentSize(width, height);
    t.setAnchorPoint(0.5, 0.5);

    const g = node.addComponent(Graphics);
    const r = clampRadius(radius, width, height);

    if (color.a > 0) {
        g.fillColor = color;
        if (r > 0) {
            g.roundRect(-width / 2, -height / 2, width, height, r);
        } else {
            g.rect(-width / 2, -height / 2, width, height);
        }
        g.fill();
    }
    if (border && border.color.a > 0) {
        g.lineWidth = border.width ?? 1;
        g.strokeColor = border.color;
        if (r > 0) {
            g.roundRect(-width / 2, -height / 2, width, height, r);
        } else {
            g.rect(-width / 2, -height / 2, width, height);
        }
        g.stroke();
    }
    return node;
}

/** 白底细边卡片（扁平风格的层次单位，与静态 .scene 里的卡片视觉一致）。 */
export function createCard(
    name: string,
    width: number,
    height: number,
    opts: { fill?: Color; border?: Color; radius?: number } = {},
): Node {
    return createRect(name, width, height, opts.fill ?? THEME.surface, opts.radius ?? RADIUS.lg, {
        color: opts.border ?? THEME.border,
        width: 1,
    });
}

/**
 * 创建文本节点。
 */
export function createLabel(
    name: string,
    text: string,
    fontSize: number = FONT.body,
    color: Color = THEME.text,
    width = 0,
): Node {
    const node = new Node(name);
    const t = node.addComponent(UITransform);
    t.setAnchorPoint(0.5, 0.5);
    if (width > 0) {
        t.setContentSize(width, Math.round(fontSize * 1.6));
    }

    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = Math.round(fontSize * 1.3);
    label.color = color;
    // 溢出处理：长文本自动换行 + 收缩，避免超出屏幕
    label.overflow = Label.Overflow.NONE;
    if (width > 0) {
        label.overflow = Label.Overflow.RESIZE_HEIGHT;
    }
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    return node;
}

/**
 * 创建扁平按钮（色块 + Label + Button 组件）。
 *
 * 样式规范：主按钮实心主色 + 白字；次按钮白底 + 1px 边 + 深灰字；
 * 危险按钮淡红底 + 红字（扁平风格不主张实心红，避免视觉噪音）。
 */
export function createButton(
    name: string,
    text: string,
    width: number,
    height: number,
    onClick: () => void,
    style: ButtonStyle = {},
): Node {
    const fill = style.fill ?? THEME.primary;
    const textColor = style.textColor ?? (fill === THEME.primary ? THEME.onPrimary : THEME.text);
    const radius = clampRadius(style.radius ?? LAYOUT.btnRadius, width, height);

    const node = createRect(name, width, height, fill, radius, style.border ? { color: style.border } : undefined);

    const label = createLabel(`${name}_label`, text, style.fontSize ?? FONT.body, textColor);
    node.addChild(label);
    label.setPosition(new Vec3(0, 0, 0));

    const btn = node.addComponent(Button);
    btn.transition = Button.Transition.SCALE;
    btn.zoomScale = 0.94;
    // 保证热区 ≥ 44pt
    const t = node.getComponent(UITransform);
    if (t && t.height < AppConfig.MIN_TOUCH_SIZE) {
        t.setContentSize(width, AppConfig.MIN_TOUCH_SIZE);
    }

    node.on(Node.EventType.TOUCH_END, () => {
        onClick();
    });

    return node;
}

/**
 * 创建垂直列表容器（Layout 自动排布）。
 */
export function createVerticalList(
    name: string,
    spacing: number,
    width: number,
    height: number,
): Node {
    const node = new Node(name);
    const t = node.addComponent(UITransform);
    t.setContentSize(width, height);
    t.setAnchorPoint(0.5, 0.5);

    const layout = node.addComponent(Layout);
    layout.type = Layout.Type.VERTICAL;
    layout.resizeMode = Layout.ResizeMode.NONE;
    layout.spacingY = spacing;
    layout.paddingTop = 0;
    layout.paddingBottom = 0;
    layout.verticalDirection = Layout.VerticalDirection.TOP_TO_BOTTOM;
    return node;
}

/**
 * 创建圆形头像占位（无美术资源时用「首字 + 底色圆」表示）。
 */
export function createAvatar(name: string, nickname: string, size = 96, color = THEME.primary): Node {
    const node = new Node(name);
    const t = node.addComponent(UITransform);
    t.setContentSize(size, size);
    t.setAnchorPoint(0.5, 0.5);

    const g = node.addComponent(Graphics);
    g.fillColor = color;
    g.circle(0, 0, size / 2);
    g.fill();
    // 扁平风格：不用浅色描边高光，仅在需要区分底色时用设计令牌的 1px 边
    g.lineWidth = 1;
    g.strokeColor = THEME.border;
    g.circle(0, 0, size / 2);
    g.stroke();

    // 取昵称首字（中文取第一个字符，英文取首字母）
    const ch = nickname && nickname.length > 0 ? nickname[0] : '?';
    const label = createLabel(`${name}_text`, ch, Math.floor(size * 0.5), THEME.onPrimary);
    node.addChild(label);
    label.setPosition(new Vec3(0, 0, 0));
    return node;
}

/**
 * 给节点添加全屏 Widget 拉伸（作为场景根容器）。
 */
export function makeFullScreen(node: Node): Widget {
    const w = node.getComponent(Widget) ?? node.addComponent(Widget);
    w.isAlignTop = true;
    w.isAlignBottom = true;
    w.isAlignLeft = true;
    w.isAlignRight = true;
    w.top = 0;
    w.bottom = 0;
    w.left = 0;
    w.right = 0;
    w.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
    return w;
}

/**
 * 创建居中对齐用的布局参数（辅助定位）。
 */
export function place(node: Node, x: number, y: number): Node {
    node.setPosition(new Vec3(x, y, 0));
    return node;
}

/**
 * 淡入动画（节点出现）。
 */
export function fadeIn(node: Node, duration = 0.2): void {
    const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
    op.opacity = 0;
    // 用 tween 需要 import，此处简单用递归 setTimeout 会不准，
    // 因此直接设置为可见（淡入由调用方按需实现）。
    op.opacity = 255;
    void duration;
}

/** 未使用引用占位，保持 Sprite/Vec2 导入可用（美术替换时使用）。 */
export type __FactoryRefs = { s: typeof Sprite; v: typeof Vec2 };

// ==================== 场景节点绑定（静态 UI 场景专用） ====================
//
// 背景：UI 现已作为【静态节点】写进 .scene（见 tools/ui-trees.js），
// 所以控制器不再运行时 createRect/createLabel 重建 UI —— 那样会重复两套。
// 控制器改为「按路径查找已有节点 + 绑定交互」。

/**
 * 按路径查找子节点，例如 findNode(this.node, 'Canvas/Header/HeaderTitle')。
 *
 * 支持从当前节点向上回溯到场景根再向下查找，因此脚本挂在 SceneRoot 上
 * 也能找到 Canvas 下的兄弟节点。
 *
 * @returns 找到的节点；任一层缺失返回 null
 */
export function findNode(from: Node, path: string): Node | null {
    // 先拿到场景根（scene 的直系子节点，即 Canvas 那一层）
    let root: Node = from;
    while (root.parent && root.parent.parent) {
        root = root.parent;
    }

    const parts = path.split('/').filter((p) => p.length > 0);
    let cur: Node | null = root;

    // 若第一段就是 root 自身的名字，跳过
    if (parts.length > 0 && cur && cur.name === parts[0]) {
        parts.shift();
    }
    for (const seg of parts) {
        if (!cur) return null;
        cur = cur.getChildByName(seg);
    }
    return cur;
}

/**
 * 按路径取节点，缺失时抛错（用于「场景必须有的关键节点」，便于尽早暴露 gen-scenes 的遗漏）。
 */
export function requireNode(from: Node, path: string): Node {
    const n = findNode(from, path);
    if (!n) {
        throw new Error(`[UIFactory] 场景缺少必需节点: ${path}（请检查 tools/ui-trees.js 与 gen-scenes.js）`);
    }
    return n;
}

/** 按路径取节点的 Label 组件（不存在返回 null）。 */
export function labelAt(from: Node, path: string): Label | null {
    const n = findNode(from, path);
    return n ? n.getComponent(Label) : null;
}

/** 按路径取节点的 UiFill 组件（静态色块运行时改色用，如卡片图标色）。 */
export function fillAt(from: Node, path: string): UiFill | null {
    const n = findNode(from, path);
    return n ? n.getComponent(UiFill) : null;
}

/**
 * 绑定按钮点击（静态场景里的 Button 节点）。
 *
 * @returns 是否绑定成功（节点缺失/无 Button 组件时返回 false 并告警）
 */
export function bindClick(from: Node, path: string, onClick: () => void): boolean {
    const n = findNode(from, path);
    if (!n) {
        console.warn(`[UIFactory] 按钮节点缺失，跳过绑定: ${path}`);
        return false;
    }
    let btn = n.getComponent(Button);
    if (!btn) {
        btn = n.addComponent(Button);
    }
    btn.transition = Button.Transition.SCALE;
    btn.zoomScale = 0.94;
    n.on(Node.EventType.TOUCH_END, onClick);
    return true;
}

/** 设置 Label 文本（节点/组件缺失时安全跳过，不抛错）。 */
export function setLabelText(from: Node, path: string, text: string): boolean {
    const l = labelAt(from, path);
    if (!l) {
        console.warn(`[UIFactory] Label 节点缺失，跳过设值: ${path}`);
        return false;
    }
    l.string = text;
    return true;
}