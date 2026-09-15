/**
 * UITheme.ts —— 全局设计令牌（Design Tokens）**唯一来源**。
 *
 * 设计方向：白底 + 扁平简约（Light / Flat / Minimal）。
 *   · 无渐变、无投影、无描边特效；用「白色卡片 + 1px 细边」划分层次
 *   · 单一主色（蓝）+ 语义色（成功/警告/危险），其余全部为中性灰阶
 *   · 圆角克制（卡片 24、按钮 16、胶囊 pill）
 *   · 8pt 间距栅格，字号 6 级
 *
 * ️ 与 tools/ 的关系：
 *   tools/theme.js 会**解析本文件**的 PALETTE / BOARD / RADIUS / SPACE / FONT / LAYOUT 常量，
 *   供 tools/ui-trees.js 生成静态场景使用 —— 因此这些块必须保持
 *   `export const NAME = { key: 'value', ... };` 这一字面量形式，
 *   值只能是单引号 hex 字符串或数字，**不要在块里写表达式/嵌套对象**，
 *   否则静态场景生成器读不到（tools/theme.js 会直接报错，不会静默用错色）。
 */

import { Color } from 'cc';

/** 调色板（hex 字面量，供 TS 与 tools 共用）。 */
export const PALETTE = {
    // 底色与容器
    bg: '#FFFFFF', // 页面底 & 卡片底（纯白，保持"白底"主基调）
    surface: '#FFFFFF', // 卡片/面板底色
    surfaceAlt: '#F6F7F9', // 次级容器底（输入/次按钮/分组底）
    sunken: '#EFF1F5', // 沉底（进度条槽、骨架、分隔块）
    border: '#E6E8EC', // 1px 细边 / 分隔线（扁平风格的核心分隔手段）
    // 语义色
    primary: '#2F6BFF', // 主色：主按钮、可点击、选中
    primarySoft: '#EAF0FF', // 主色淡底（次级按钮 / 标签底）
    success: '#12B76A',
    successSoft: '#E8F8F0',
    warn: '#F79009',
    warnSoft: '#FFF4E5',
    danger: '#F04438',
    dangerSoft: '#FDECEA',
    accent: '#7B61FF', // 辅助色（第二款游戏标识）
    accentSoft: '#F1EEFF',
    // 文字（三级灰阶）
    ink: '#1A1D24', // 一级：标题
    inkSoft: '#5A6272', // 二级：正文/说明
    inkFaint: '#98A0AE', // 三级：占位/弱提示
    onPrimary: '#FFFFFF', // 主色上的文字
    // 浮层
    toastBg: '#22262F', // Toast 深色胶囊（浅色界面里最稳的对比）
    overlay: '#10131A', // 蒙层基色（配合 alpha 使用）
} as const;

/** 棋盘配色（浅色扁平，与页面同调）。 */
export const BOARD = {
    gomokuBg: '#FFFFFF',
    gomokuLine: '#D8DDE4',
    gomokuStar: '#3B4250',
    blackStone: '#22262F',
    whiteStone: '#FFFFFF',
    stoneEdge: '#C9D0DA',
    lastMark: '#F04438',
    winLine: '#F79009',
    huntBg: '#FFFFFF',
    huntLine: '#DFE3E9',
    huntHidden: '#F1F3F7',
    huntEmpty: '#FFFFFF',
    huntBody: '#2F6BFF',
    huntHead: '#F79009',
} as const;

/** 圆角（pill 由代码按高度一半夹取，不要直接用于 roundRect）。 */
export const RADIUS = { sm: 8, md: 16, lg: 24, pill: 999 } as const;

/** 间距栅格（8pt 基准）。 */
export const SPACE = { xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

/** 字号（6 级，禁止在业务代码里写魔法数字）。 */
export const FONT = { display: 56, h1: 42, h2: 32, body: 28, sub: 24, caption: 20 } as const;

/** 布局栅格（设计分辨率 720×1280 竖屏）。 */
export const LAYOUT = {
    designW: 720,
    designH: 1280,
    gutter: 32, // 页面左右留白 → 内容宽 656
    headerH: 152, // 顶部栏高度（含状态栏避让）
    cardRadius: 24, // 卡片圆角
    cardW: 656, // 卡片宽度 = designW - gutter*2
    btnH: 88, // 主按钮高度（≥44pt 热区）
    btnRadius: 16,
    rowGap: 24, // 卡片/行间距
    dividerH: 2, // 分隔线粗细（视觉上约 1 物理像素）
} as const;

/** hex → Color（唯一实现，UIFactory 转发引用）。 */
export function hexToColor(hex: string, alpha = 255): Color {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    return new Color(r, g, b, alpha);
}

/**
 * 运行时主题（Color 实例）。
 *
 * 键名与旧版 THEME 保持兼容（panel / panelLight 保留为别名），
 * 新增语义键：surfaceAlt / border / textFaint / onPrimary / toastBg / overlay。
 */
export const THEME = {
    bg: hexToColor(PALETTE.bg),
    surface: hexToColor(PALETTE.surface),
    surfaceAlt: hexToColor(PALETTE.surfaceAlt),
    sunken: hexToColor(PALETTE.sunken),
    border: hexToColor(PALETTE.border),
    primary: hexToColor(PALETTE.primary),
    primarySoft: hexToColor(PALETTE.primarySoft),
    success: hexToColor(PALETTE.success),
    successSoft: hexToColor(PALETTE.successSoft),
    warn: hexToColor(PALETTE.warn),
    warnSoft: hexToColor(PALETTE.warnSoft),
    danger: hexToColor(PALETTE.danger),
    dangerSoft: hexToColor(PALETTE.dangerSoft),
    accent: hexToColor(PALETTE.accent),
    accentSoft: hexToColor(PALETTE.accentSoft),
    text: hexToColor(PALETTE.ink),
    textDim: hexToColor(PALETTE.inkSoft),
    textFaint: hexToColor(PALETTE.inkFaint),
    onPrimary: hexToColor(PALETTE.onPrimary),
    toastBg: hexToColor(PALETTE.toastBg),
    // —— 旧键别名（避免历史代码断裂）——
    panel: hexToColor(PALETTE.surface),
    panelLight: hexToColor(PALETTE.surfaceAlt),
} as const;

/** 蒙层色（带 alpha）。 */
export function overlayColor(alpha = 130): Color {
    return hexToColor(PALETTE.overlay, alpha);
}