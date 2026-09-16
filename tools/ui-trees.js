/**
 * ui-trees.js —— 每个场景的【静态 UI 节点树】定义（**唯一 UI 布局来源**）。
 *
 * 设计系统：白底 + 扁平简约（Light / Flat / Minimal）
 *   · 所有颜色/圆角/间距/字号都来自 `assets/scripts/config/UITheme.ts`（经 tools/theme.js 解析），
 *     本文件**不写死任何 hex**，避免"改一处忘一处"造成第二套白色/第二套蓝色。
 *   · 色块统一用 UiFill 自绘组件（`assets/scripts/core/UiFill.ts`）：
 *     cc.Graphics 不序列化绘制路径，直接写进 .scene 是空组件、什么都画不出来。
 *
 * 坐标系：Canvas 720×1280，中心为原点（anchor 0.5,0.5）。
 *   顶部 y=+640，底部 y=-640，左右 x=±360；左右留白 gutter=32 → 内容宽 656。
 *
 * 统一布局栅格（4 屏共用，详见 docs/UI_DESIGN.md）：
 *   ┌ 顶部栏 Header 高 152（白底 + 底部 1px 分隔线），标题左对齐、辅助信息右对齐
 *   ├ 主内容区：卡片(白底 + 1px 边 + 圆角 24)、行间距 24、内容宽 656
 *   ├ 底部操作区：按钮高 88（≥44pt 热区）、圆角 16
 *   └ 页脚 caption 20 号弱灰，y=-600
 *
 * 组件规范：
 *   主按钮  = primary 实心 + onPrimary 文字
 *   次按钮  = 白底 + border 描边 + ink 文字
 *   危险按钮= dangerSoft 淡底 + danger 文字（扁平化，不用实心红）
 *   卡片    = 白底 + border 1px；不用阴影/渐变
 */
const fs = require('fs');
const path = require('path');
const B = require('./scene-builder.js');
const T = require('./theme.js');

const {
    LAYER_UI_2D,
    makeNode, label, scrollView, layout, progressBar, mask, button,
    hexToColor, nodeRef,
} = B;

/** 脚本压缩 uuid（权威表由 tools/extract-script-uuids.js 生成并自校验）。 */
const SCRIPT_UUID = JSON.parse(fs.readFileSync(path.join(__dirname, 'script-uuids.json'), 'utf8'));
const FILL = SCRIPT_UUID.UiFill;

/** 设计令牌（来自 UITheme.ts）。 */
const C = T.PALETTE;
const BOARD = T.BOARD;
const RADIUS = T.RADIUS;
const SPACE = T.SPACE;
const FONT = T.FONT;
const LAYOUT = T.LAYOUT;

const DESIGN_W = LAYOUT.designW;
const DESIGN_H = LAYOUT.designH;
const GUTTER = LAYOUT.gutter;
const CONTENT_W = LAYOUT.cardW;
/** 内容左边缘（用于左对齐文本定位）。 */
const LEFT = -DESIGN_W / 2 + GUTTER;

// =====================================================================
// 基础件
// =====================================================================

/** UiFill 组件声明：扁平色块（填充 + 可选 1px 描边）。 */
function fillComp(hex, opts = {}) {
    const { radius = 0, borderHex = null, borderWidth = 0, alpha = 255 } = opts;
    return {
        type: FILL,
        body: {
            fillColor: hexToColor(hex, alpha),
            radius,
            borderColor: borderHex ? hexToColor(borderHex) : hexToColor('#000000', 0),
            borderWidth: borderHex ? borderWidth : 0,
            drawOnLoad: true,
        },
    };
}

/** 色块节点（扁平基础件：页面底 / 卡片 / 胶囊 / 图标底）。 */
function fillNode(name, w, h, hex, opts = {}) {
    return makeNode(name, {
        pos: opts.pos || [0, 0],
        size: [w, h],
        anchor: opts.anchor || [0.5, 0.5],
        layer: LAYER_UI_2D,
        active: opts.active === undefined ? true : opts.active,
    }, [
        fillComp(hex, {
            radius: opts.radius === undefined ? 0 : opts.radius,
            borderHex: opts.borderHex || null,
            borderWidth: opts.borderWidth === undefined ? 1 : opts.borderWidth,
            alpha: opts.alpha === undefined ? 255 : opts.alpha,
        }),
    ], opts.children || []);
}

/** 卡片节点（白底 + 1px 细边 + 圆角 24 —— 扁平风格的层次来源）。 */
function cardNode(name, w, h, opts = {}) {
    return fillNode(name, w, h, opts.hex || C.surface, {
        ...opts,
        radius: opts.radius === undefined ? RADIUS.lg : opts.radius,
        borderHex: opts.borderHex || C.border,
        borderWidth: 1,
    });
}

/** 文本节点。hAlign: 0=左 1=中 2=右；overflow: 0=NONE 1=CLAMP 3=RESIZE_HEIGHT。 */
function textNode(name, str, fontSize, hex, opts = {}) {
    return makeNode(name, {
        pos: opts.pos || [0, 0],
        size: opts.size || [CONTENT_W, fontSize + 12],
        anchor: opts.anchor || [0.5, 0.5],
        layer: LAYER_UI_2D,
        active: opts.active === undefined ? true : opts.active,
    }, [
        {
            type: 'cc.Label',
            body: label({
                string: str,
                fontSize,
                colorHex: hex,
                horizontalAlign: opts.hAlign === undefined ? 1 : opts.hAlign,
                verticalAlign: opts.vAlign === undefined ? 1 : opts.vAlign,
                overflow: opts.overflow === undefined ? 1 : opts.overflow,
                enableWrapText: opts.wrap === undefined ? false : opts.wrap,
                isBold: opts.bold || false,
                lineHeight: opts.lineHeight || undefined,
            }),
        },
    ]);
}

/** 1px 分隔线（替代投影做区域划分）。 */
function dividerNode(name, w, opts = {}) {
    return fillNode(name, w, LAYOUT.dividerH, opts.hex || C.border, {
        ...opts,
        radius: 0,
    });
}

/**
 * 按钮（扁平三态：主/次/危险）。
 *
 * opts.style: 'primary' | 'secondary' | 'danger'
 * 子节点名固定为 `<name>Label`（控制器按路径取文案）。
 */
function buttonNode(name, str, w, h, opts = {}) {
    const style = opts.style || 'primary';
    const palette = {
        primary: { fill: C.primary, text: C.onPrimary, border: null },
        secondary: { fill: C.surface, text: C.ink, border: C.border },
        soft: { fill: C.primarySoft, text: C.primary, border: null },
        danger: { fill: C.dangerSoft, text: C.danger, border: null },
    }[style];
    if (!palette) {
        throw new Error('buttonNode: 未知按钮样式 ' + style);
    }

    const radius = opts.radius === undefined ? LAYOUT.btnRadius : opts.radius;
    return makeNode(name, {
        pos: opts.pos || [0, 0],
        size: [w, h],
        layer: LAYER_UI_2D,
        active: opts.active === undefined ? true : opts.active,
    }, [
        fillComp(palette.fill, { radius, borderHex: palette.border, borderWidth: 1 }),
        button(),
    ], [
        textNode(`${name}Label`, str, opts.fontSize || FONT.body, palette.text, {
            size: [w - 24, h - 8],
            overflow: 1,
        }),
    ]);
}

/**
 * 全屏浮层容器（Toast / 弹窗的统一父节点）。
 *
 * 为什么必须有它：
 *   `GameList/view` 挂了 `cc.Mask`（ScrollView 裁剪）。运行时把 Toast/弹窗直接
 *   addChild 到 Canvas，会与 GameList 成为兄弟，受同一套 UI 渲染顺序影响；
 *   用一个独立的、排在最后的浮层容器承载，层级语义最清晰。
 *
 * ⚠️ 它**必须挂 UITransform**（这里曾经踩坑，且代价很大）：
 *   最初把它写成「零组件裸节点」，理由是"容器不需要自己的尺寸"。
 *   结果：节点创建正常、日志正常、尺寸/缩放/透明度全对，但**屏幕上完全看不见** ——
 *   因为 Cocos 3.x 的 UI 渲染依赖父节点的 UITransform 参与世界变换与
 *   渲染批次计算，没有 UITransform 的中间节点会让子树的位置/裁剪失效。
 *   症状极具误导性：所有断言（节点存在、尺寸>0、alpha>0）都通过，就是不可见。
 *   所以：这里是**全屏尺寸的 UITransform**（设计分辨率，居中锚点），
 *   让子节点的坐标语义与 Canvas 保持一致（原点在中心）。
 */
function overlayNode() {
    return makeNode('Overlay', {
        pos: [0, 0], size: [DESIGN_W, DESIGN_H], layer: LAYER_UI_2D,
    }, [], []);
}

// =====================================================================
// Loading 场景 —— 微信小游戏「明确的加载页」
// =====================================================================
/**
 * 为什么必须有这一屏（微信小游戏审核/体验的硬要求，不是可选项）：
 *   1. 小游戏冷启动要先下载代码包 + 初始化引擎，这段时间**屏幕上什么都没有**，
 *      若不提供加载页，用户看到的是白屏/黑屏，会被判「无响应」；
 *   2. 官方《小游戏接入指南》要求：加载过程需有明确进度反馈，
 *      且**必须提供「加载中」的可视状态**（文字或进度条），不能静默等待；
 *   3. 版本更新（wx.getUpdateManager）的「新版本已就绪」提示也要落在这一屏上，
 *      因为更新下载发生在进入业务逻辑之前。
 *
 * 本页构成（全部静态节点，控制器只绑路径不改结构）：
 *   Bg              页面底
 *   LogoBar         品牌标（主色圆角块 + 首字）
 *   Title/Subtitle  游戏名 + 副标题
 *   ProgressBarBg   进度条槽（内含 ProgressBarFill，脚本用 scale.x 驱动）
 *   ProgressText    百分比数字「0%」（独立节点，便于大号显示）
 *   Status          当前阶段文案（正在加载资源 / 正在登录 / 正在检查更新…）
 *   Version         版本 + 运行模式 + 设计分辨率
 *   Hint            卡住时的兜底提示（长时间无进展才显示）
 */
function loadingTree() {
    const bg = fillNode('Bg', DESIGN_W, DESIGN_H, C.bg);

    // 品牌标：主色圆角方块 + 白色首字（扁平、零美术资源）
    const logo = fillNode('Logo', 168, 168, C.primary, {
        pos: [0, 300], radius: RADIUS.lg,
        children: [
            textNode('LogoText', '合', FONT.display, C.onPrimary, {
                pos: [0, 0], size: [168, 84], bold: true,
            }),
        ],
    });

    const title = textNode('Title', '小游戏合集', FONT.display, C.ink, {
        pos: [0, 140], size: [640, 78], bold: true,
    });
    const subtitle = textNode('Subtitle', '寻机头 · 五子棋', FONT.sub, C.inkFaint, {
        pos: [0, 78], size: [640, 40],
    });

    // 进度条：槽（sunken 胶囊）+ 填充（primary 胶囊，anchor 左端，脚本用 scale.x 驱动）
    const barFill = fillNode('ProgressBarFill', 480, 12, C.primary, {
        pos: [0, 0], anchor: [0, 0.5], radius: RADIUS.pill,
    });
    const barBg = fillNode('ProgressBarBg', 480, 12, C.sunken, {
        pos: [0, -200], radius: RADIUS.pill, children: [barFill],
    });
    // cc.ProgressBar：字段可见于层级管理器（_barSprite 仍为空，进度由脚本驱动 scale.x）
    barBg.comps.push(B.normalizeComp({ type: 'cc.ProgressBar', body: progressBar(null, 0, 1, 0.1, false) }));

    // 百分比数字（大号，独立节点 —— 微信审核看「有没有明确进度反馈」主要看它）
    const progressText = textNode('ProgressText', '0%', FONT.h2, C.primary, {
        pos: [0, -262], size: [640, 46], bold: true,
    });

    const status = textNode('Status', '正在加载资源…', FONT.sub, C.inkSoft, {
        pos: [0, -320], size: [640, 40],
    });

    // 长时间无进展时的兜底提示（初值为占位符 —— Label 不能是空串，
    // 空串会被 validate-scenes.js 判为「不可见」；脚本用空格覆盖它表示隐藏）
    const hint = textNode('Hint', '加载中', FONT.caption + 2, C.warn, {
        pos: [0, -380], size: [640, 34],
    });

    // 占位文本：运行时由 LoadingScene 按 AppConfig.APP_VERSION 刷新
    // （版本号唯一来源在 AppConfig，这里只负责「非空且不误导」）
    const version = textNode('Version', 'v0.1.1  |  Mock 预览模式  |  720x1280', FONT.caption, C.inkFaint, {
        pos: [0, -600], size: [660, 34],
    });

    const overlay = overlayNode();

    return [bg, logo, title, subtitle, barBg, progressText, status, hint, version, overlay];
}

// =====================================================================
// Lobby 场景 —— 游戏大厅
// =====================================================================
function lobbyTree() {
    const bg = fillNode('Bg', DESIGN_W, DESIGN_H, C.bg);
    const overlay = overlayNode();

    // ---- 顶部栏：白底 + 底部 1px 分隔线，标题左对齐 / 用户右对齐 ----
    const header = fillNode('Header', DESIGN_W, LAYOUT.headerH, C.surface, {
        pos: [0, DESIGN_H / 2 - LAYOUT.headerH / 2],
        children: [
            dividerNode('HeaderDivider', DESIGN_W, { pos: [0, -LAYOUT.headerH / 2] }),
            textNode('HeaderTitle', '游戏大厅', FONT.h1, C.ink, {
                pos: [LEFT + 150, 4], size: [300, 54], hAlign: 0, bold: true,
            }),
            textNode('HeaderUser', '👤 未登录', FONT.sub, C.inkFaint, {
                pos: [DESIGN_W / 2 - GUTTER - 120, 2], size: [240, 40], hAlign: 2,
            }),
        ],
    });

    // ---- 游戏列表（ScrollView > view(Mask) > content(Layout 纵向)）----
    const VIEW_W = CONTENT_W;
    const VIEW_H = 840;
    const VIEW_Y = 44;

    const content = makeNode('content', {
        pos: [0, VIEW_H / 2], size: [VIEW_W, 100], anchor: [0.5, 1], layer: LAYER_UI_2D,
    }, [
        {
            type: 'cc.Layout',
            body: layout({
                type: 2,          // VERTICAL
                resizeMode: 1,    // CONTAINER
                startAxis: 1,     // HORIZONTAL
                paddingTop: 0,
                paddingBottom: 0,
                spacingY: LAYOUT.rowGap,
                verticalDirection: 1, // TOP_TO_BOTTOM
            }),
        },
    ]);

    const view = makeNode('view', {
        pos: [0, 0], size: [VIEW_W, VIEW_H], layer: LAYER_UI_2D,
    }, [
        { type: 'cc.Mask', body: mask(0) }, // GRAPHICS_RECT
    ], [content]);

    // ⚠️ content 引用必须用 nodeRef（直接传描述对象会写进垃圾数据，ScrollView 会失效）
    const svComp = scrollView(null, false, true);
    svComp.content = nodeRef(content);

    const gameList = makeNode('GameList', {
        pos: [0, VIEW_Y], size: [VIEW_W, VIEW_H], layer: LAYER_UI_2D,
    }, [B.normalizeComp(svComp)], [view]);

    // ---- 卡片（静态可见；文案/图标色由 LobbyScene 用配置覆盖）----
    // content 顶边为 0，Layout TOP_TO_BOTTOM：card1 中心 -100，card2 中心 -324
    const cardH = 200;
    const step = cardH + LAYOUT.rowGap;
    content.children.push(
        makeCard('Card_planehunt', '寻机头', '12×12 搜寻 5 架飞机', '机', C.primary, -cardH / 2),
        makeCard('Card_gomoku', '五子棋', '15×15 连五者胜', '棋', C.accent, -cardH / 2 - step),
    );

    const footer = textNode('Footer', 'MVP：寻机头 · 五子棋  |  数据来源：Mock 通道', FONT.caption, C.inkFaint, {
        pos: [0, -600], size: [660, 34],
    });

    return [bg, header, gameList, footer, overlay];
}

/**
 * 单张游戏卡片。
 *
 * 布局（卡片 656×200，内边距 24）：[图标 112] 24 [文案列 320] 24 [按钮 160]
 * 路径契约：Card_x/Icon/IconText、Card_x/Name、Card_x/Desc、Card_x/Online、Card_x/PlayBtn/PlayBtnLabel
 */
function makeCard(id, name, desc, iconText, iconHex, y) {
    const cardW = CONTENT_W;
    const pad = SPACE.lg;
    const iconSize = 112;
    const btnW = 160;

    const iconX = -cardW / 2 + pad + iconSize / 2;
    const btnX = cardW / 2 - pad - btnW / 2;
    const colLeft = iconX + iconSize / 2 + SPACE.lg;
    const colRight = btnX - btnW / 2 - SPACE.lg;
    const colW = colRight - colLeft;
    const colCx = colLeft + colW / 2;

    const card = cardNode(id, cardW, 200, { pos: [0, y] });

    const icon = fillNode('Icon', iconSize, iconSize, iconHex, {
        pos: [iconX, 0], radius: RADIUS.md,
        children: [
            textNode('IconText', iconText, FONT.h2, C.onPrimary, {
                pos: [0, 0], size: [iconSize, iconSize], bold: true,
            }),
        ],
    });

    card.children.push(
        icon,
        textNode('Name', name, FONT.h2, C.ink, {
            pos: [colCx, 50], size: [colW, 44], hAlign: 0, bold: true,
        }),
        textNode('Desc', desc, FONT.caption + 2, C.inkSoft, {
            pos: [colCx, 8], size: [colW, 32], hAlign: 0,
        }),
        textNode('Online', '在线 --', FONT.caption, C.success, {
            pos: [colCx, -34], size: [colW, 30], hAlign: 0,
        }),
        buttonNode('PlayBtn', '开始游戏', btnW, 64, {
            pos: [btnX, 0], style: 'primary', fontSize: FONT.sub + 2, radius: RADIUS.md,
        }),
    );
    return card;
}

// =====================================================================
// Room 场景 —— 房间准备
// =====================================================================
function roomTree() {
    const bg = fillNode('Bg', DESIGN_W, DESIGN_H, C.bg);
    const overlay = overlayNode();

    const header = fillNode('Header', DESIGN_W, LAYOUT.headerH, C.surface, {
        pos: [0, DESIGN_H / 2 - LAYOUT.headerH / 2],
        children: [
            dividerNode('HeaderDivider', DESIGN_W, { pos: [0, -LAYOUT.headerH / 2] }),
            textNode('RoomTitle', '游戏房间', FONT.h1, C.ink, {
                pos: [LEFT + 150, 18], size: [300, 54], hAlign: 0, bold: true,
            }),
            textNode('RoomId', '房间号：------', FONT.sub, C.inkFaint, {
                pos: [LEFT + 150, -22], size: [300, 36], hAlign: 0,
            }),
        ],
    });

    const seatTop = makeSeat('SeatTop', '玩家一', 340, C.primary);
    const vs = textNode('VsLabel', 'VS', FONT.h2, C.inkFaint, {
        pos: [0, 205], size: [160, 46], bold: true,
    });
    const seatBottom = makeSeat('SeatBottom', '玩家二', 70, C.accent);

    const status = textNode('Status', '正在进入房间…', FONT.sub + 2, C.inkSoft, {
        pos: [0, -130], size: [CONTENT_W, 44],
    });

    const btnReady = buttonNode('BtnReady', '准  备', 300, 92, {
        pos: [-163, -480], style: 'primary', fontSize: FONT.h2, radius: RADIUS.lg,
    });
    const btnLeave = buttonNode('BtnLeave', '离  开', 300, 92, {
        pos: [163, -480], style: 'secondary', fontSize: FONT.h2, radius: RADIUS.lg,
    });

    return [bg, header, seatTop, vs, seatBottom, status, btnReady, btnLeave, overlay];
}

/** 座位卡：白底 + 1px 边 + 左侧 6px 色条（扁平的身份标识）。 */
function makeSeat(name, who, y, accentHex) {
    const seat = cardNode(name, CONTENT_W, 200, { pos: [0, y] });
    seat.children.push(
        fillNode('SeatAccent', 6, 152, accentHex, { pos: [-CONTENT_W / 2 + 12, 0], radius: RADIUS.pill }),
        textNode('SeatName', who, FONT.body + 2, C.ink, { pos: [12, 50], size: [560, 46], bold: true }),
        textNode('SeatStatus', '等待加入…', FONT.sub, C.inkSoft, { pos: [12, 0], size: [560, 40] }),
        textNode('SeatScore', '战绩：--', FONT.caption, C.inkFaint, { pos: [12, -50], size: [560, 34] }),
    );
    return seat;
}

// =====================================================================
// Game 场景 —— 对局
// =====================================================================
function gameTree() {
    const bg = fillNode('Bg', DESIGN_W, DESIGN_H, C.bg);
    const overlay = overlayNode();

    // ---- 顶部 HUD：对手行 / 我方行 / 状态行（白底 + 底部 1px 分隔线）----
    //
    // 布局意图（本次重排，修掉「双方信息糊成一团 + 回合显示被覆盖」）：
    //   左右两栏 = 对手 | 我，各占半宽；中间靠一条竖分隔线分开。
    //   每栏内自上而下：昵称 → 分数（大字）。当前回合方在整个行上高亮。
    //   底部独立一条「回合指示 + 倒计时」，与双方信息**分成两个视觉层**，
    //   避免回合文案和玩家信息互相干扰。
    //
    //   节点契约（GameScene 按路径绑定，改名要同步）：
    //     Hud/OppName  Hud/OppScore  Hud/MyName  Hud/MyScore
    //     Hud/TurnLabel（回合）  Hud/TimerLabel（倒计时）
    //     Hud/HeadsLabel（寻机头专用：已找到机头 n/5）
    //     Hud/OppTurnMark / Hud/MyTurnMark（回合高亮圆点，◆ 当前回合）
    const HUD_H = 248;
    const HUD_Y = 512;
    /** 左右两栏中心（画布宽 720，留 gutter 32 → 内容 656；每栏 328） */
    const COL_L = -164;
    const COL_R = 164;
    const hud = fillNode('Hud', DESIGN_W, HUD_H, C.surface, {
        pos: [0, HUD_Y],
        children: [
            dividerNode('HudDivider', DESIGN_W, { pos: [0, -HUD_H / 2] }),

            // 中缝竖分隔线（两栏的视觉边界）—— 用 fillNode 直接给 1px 宽 × 高
            fillNode('HudColSplit', 1, HUD_H - 36, C.border, {
                pos: [0, 4],
            }),

            // ---- 左栏：对手 ----
            textNode('OppTurnMark', '◆', FONT.caption + 2, C.warn, {
                pos: [COL_L - 120, 62], size: [40, 34],
            }),
            textNode('OppName', '对手', FONT.sub + 2, C.inkSoft, {
                pos: [COL_L - 40, 62], size: [200, 36], hAlign: 0, overflow: 1,
            }),
            textNode('OppScore', '0', FONT.display, C.danger, {
                pos: [COL_L, 8], size: [240, 56], bold: true,
            }),

            // ---- 右栏：我 ----
            textNode('MyTurnMark', '◆', FONT.caption + 2, C.success, {
                pos: [COL_R - 120, 62], size: [40, 34],
            }),
            textNode('MyName', '我', FONT.sub + 2, C.ink, {
                pos: [COL_R - 40, 62], size: [200, 36], hAlign: 0, bold: true, overflow: 1,
            }),
            textNode('MyScore', '0', FONT.display, C.success, {
                pos: [COL_R, 8], size: [240, 56], bold: true,
            }),

            // ---- 状态行：回合指示（左）+ 倒计时（右）----
            textNode('TurnLabel', '对局开始', FONT.sub + 2, C.warn, {
                pos: [LEFT + 190, -64], size: [400, 40], hAlign: 0, bold: true,
            }),
            textNode('TimerLabel', '30s', FONT.sub, C.inkFaint, {
                pos: [DESIGN_W / 2 - GUTTER - 60, -64], size: [160, 40], hAlign: 2,
            }),

            // ---- 寻机头专用：已找到机头数（其他游戏运行时置空格隐藏）----
            // ⚠️ 初值必须是**真实占位文案**：空串会被 validate-scenes.js 判为
            //    「不可见」而校验失败（它正是为了拦住「Label 是空的所以看不见」）。
            textNode('HeadsLabel', '已找到机头 0 / 5', FONT.sub, C.inkSoft, {
                pos: [0, -104], size: [CONTENT_W, 36],
            }),
        ],
    });

    // ---- 棋盘区：白卡 + 1px 边（棋盘内容由 BoardBase 运行时绘制）----
    const BOARD_SIZE = 656;
    const boardArea = cardNode('BoardArea', BOARD_SIZE, BOARD_SIZE, {
        pos: [0, -30],
        children: [
            textNode('BoardHint', '棋盘', FONT.body, C.inkFaint, { pos: [0, 0], size: [400, 40] }),
        ],
    });

    // ---- 表情面板（默认隐藏，脚本按需显示）----
    // y 取 -424：上方与棋盘底边(-358)留 18px，下方与操作栏顶边(-472)留 0px
    // （HUD 加高到 248 后重新核过，见本函数头部注释）
    const emotePanel = cardNode('EmotePanel', CONTENT_W, 96, {
        pos: [0, -424], active: false,
        children: [
            textNode('EmoteList', '👍    😭  😡    👏', 36, C.ink, { pos: [0, 0], size: [CONTENT_W - 40, 60] }),
        ],
    });

    // ---- 底部操作栏：白底 + 顶部 1px 分隔线，三个等宽按钮 ----
    const BAR_H = 168;
    const bar = fillNode('ActionBar', DESIGN_W, BAR_H, C.surface, {
        pos: [0, -DESIGN_H / 2 + BAR_H / 2],
        children: [
            dividerNode('ActionBarDivider', DESIGN_W, { pos: [0, BAR_H / 2] }),
            buttonNode('BtnEmote', '表情', 200, 84, { pos: [-222, 0], style: 'secondary', fontSize: FONT.body, radius: RADIUS.lg }),
            buttonNode('BtnRestart', '重开', 200, 84, { pos: [0, 0], style: 'secondary', fontSize: FONT.body, radius: RADIUS.lg }),
            buttonNode('BtnLeaveGame', '退出', 200, 84, { pos: [222, 0], style: 'danger', fontSize: FONT.body, radius: RADIUS.lg }),
        ],
    });

    return [bg, hud, boardArea, emotePanel, bar, overlay];
}

module.exports = {
    loadingTree,
    lobbyTree,
    roomTree,
    gameTree,
    // 供校验脚本复用
    PALETTE: C,
    BOARD,
    LAYOUT,
    FONT,
    RADIUS,
};