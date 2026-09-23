/**
 * PortraitAdapter.ts —— 竖版机型自适应（任意竖屏宽高比 / 任意刘海）。
 *
 * ## 要解决的问题
 *
 * 原先的适配方案是「固定 720×1280 设计分辨率 + FIXED_WIDTH（只按宽度撑满）」：
 *   · 横向：宽度永远撑满，等于**不缩放**；
 *   · 纵向：可视高度 = 720 / (屏宽/屏高)。19.5:9（如 iPhone 12）实测可视高约 1560，
 *     远大于 1280 → 上下各多出 ~140，写死 y=+640 的顶栏与 y=-640 的底栏
 *     **不在屏幕边缘**（顶栏下面空一截、底栏上面空一截）；
 *   · 结果：机型一变，顶/底栏位置就漂，中间只剩一块固定的 720×1280 白板。
 *
 * 结论：固定设计分辨率这条路在竖版机型多样性面前走不通 —— 必须**按机型算尺寸**。
 *
 * ## 采用的方案：运行期重算设计分辨率（FIXED_WIDTH 语义 + 动态设计高）
 *
 * 保留「宽度基准」的直觉（内容宽 720 在所有机型上视觉宽度一致，排版不会因
 * 机型变宽而变形），把**设计高度按机型实算**：
 *
 *   designW = 720（常量，宽度基准）
 *   aspect  = 屏幕高 / 屏幕宽
 *   designH = round(designW * aspect)          ← 任意竖版机型的真实可视高度
 *   view.setDesignResolutionSize(designW, designH, ResolutionPolicy.FIXED_WIDTH)
 *
 * 效果：
 *   · 可视区**恰好**铺满屏幕，不裁切也不留黑边（等比且宽高都吻合）；
 *   · 顶栏/底栏用 Widget 贴 Canvas 上下边 → 永远在屏幕边缘（见 tools/ui-trees.js）；
 *   · 中间内容区按「安全区内可用高度」重新分配位置（见各场景控制器的布局方法），
 *     长屏多出的空间变成更舒展的留白，而不是集中在一处形成空洞。
 *
 * ## 安全区（刘海 / 灵动岛 / Home 条 / 侧边挖孔）
 *
 * 安全区以**物理/逻辑像素**给出，换算到设计坐标系：
 *
 *   k = designW / screenWidth        （FIXED_WIDTH 下横向缩放比）
 *   topInset    = safeArea.top * k
 *   bottomInset = (screenHeight - safeArea.bottom) * k    ← 注意是「屏高 - 底边」
 *   leftInset   = safeArea.left * k
 *   rightInset  = (screenWidth - safeArea.right) * k
 *
 * ⚠️ 这里最容易错的是底边：`safeArea.bottom` 是**底部安全边的 y 坐标**，
 * 不是「底部避让高度」。避让高度必须是 `screenHeight - safeArea.bottom`。
 *
 * ## 单位口径（务必一致）
 *
 * 屏幕尺寸与 safeArea 必须**同一单位**（都用逻辑 px），因为换算只依赖
 * 「比值」与「相对位置」。若 `screen.windowSize` 是物理 px 而 safeArea 是逻辑 px，
 * 侧边避让会算错 —— 因此这里**优先整体使用平台层的逻辑 px 数据**，
 * `screen.windowSize` 只作为拿不到平台数据时的尺寸来源。
 *
 * 本模块**只做计算与写分辨率**，不持有任何节点引用，可被任意场景安全复用。
 */

import { Node, screen, sys, view, UITransform, Widget, ResolutionPolicy } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { services } from './ServiceLocator';

/** 计算出的竖版布局参数（设计坐标系，原点在 Canvas 中心）。 */
export interface PortraitLayout {
    /** 设计宽度（固定为宽度基准 720）。 */
    designW: number;
    /** 设计高度（按机型实算）。 */
    designH: number;
    /** 屏幕宽高比（高 / 宽），如 2.167（19.5:9）。 */
    aspect: number;
    /** 本次是否真的重设了分辨率（false = 与上次相同，可跳过重排）。 */
    changed: boolean;
    /** 安全区避让（设计坐标系，px）。 */
    safeTop: number;
    safeBottom: number;
    safeLeft: number;
    safeRight: number;
    /** 安全区内可用区域（用于把内容摆进不被遮挡的范围）。 */
    safeH: number;
    safeW: number;
    /** 安全区中心相对 Canvas 中心的 y 偏移（上下避让不等时不为 0）。 */
    safeCenterY: number;
    /** 画布上/下边缘（== designH/2）。 */
    topY: number;
    bottomY: number;
    /** 安全区的上/下边缘 y。 */
    safeTopY: number;
    safeBottomY: number;
    /** 是否检测到「异常宽高比」（极窄或极宽，按竖版兜底处理）。 */
    abnormal: boolean;
}

/** 竖版机型的合理高宽比区间（超出即视为异常数据，走兜底）。 */
const ASPECT_MIN = 1.2; // 近乎方屏（如 iPad 竖屏 4:3=1.333 仍在范围内）
const ASPECT_MAX = 2.6; // 极端长屏（21:9=2.333 仍容忍；再长视为数据异常）

/** 兜底安全区（拿不到系统信息时使用，与 AppConfig 保持一致）。 */
const FALLBACK_TOP = AppConfig.SAFE_AREA_FALLBACK_TOP;
const FALLBACK_BOTTOM = AppConfig.SAFE_AREA_FALLBACK_BOTTOM;

/**
 * 竖版自适应适配器（全局单例）。
 *
 * 用法（各场景控制器 onLoad 首行之后立即调用）：
 *
 *   portfolioAdapter.apply();                    // 重算 + 重设分辨率
 *   const L = portraitAdapter.layout;            // 取布局参数排布内容
 */
export class PortraitAdapter {
    private static _inst: PortraitAdapter | null = null;

    /** 最近一次计算出的布局（apply 之前为 null）。 */
    private _layout: PortraitLayout | null = null;
    /** 上次应用的 (designW, designH)，用于判断「是否需要重排」。 */
    private _appliedW = 0;
    private _appliedH = 0;

    public static get instance(): PortraitAdapter {
        if (!PortraitAdapter._inst) {
            PortraitAdapter._inst = new PortraitAdapter();
        }
        return PortraitAdapter._inst;
    }

    /** 最近一次的布局参数；未 apply 过时按基准比例估算一份（不写分辨率）。 */
    public get layout(): PortraitLayout {
        return this._layout ?? this._compute(false);
    }

    /**
     * 重算并应用竖版设计分辨率。
     *
     * @returns 本次的布局参数（`changed=true` 表示分辨率真的变了，调用方需要重排）
     */
    public apply(): PortraitLayout {
        const next = this._compute(true);
        const changed = next.designW !== this._appliedW || next.designH !== this._appliedH;

        if (changed) {
            // FIXED_WIDTH：横向按 designW 撑满。因为 designH 是按屏幕比例实算的，
            // 纵向也恰好撑满 —— 等比 + 铺满，不裁切不留边。
            view.setDesignResolutionSize(next.designW, next.designH, ResolutionPolicy.FIXED_WIDTH);
            this._appliedW = next.designW;
            this._appliedH = next.designH;
            console.log(
                `[PortraitAdapter] 竖版自适应：设计 ${next.designW}x${next.designH} ` +
                    `(比例 ${next.aspect.toFixed(3)}) 安全区 top=${next.safeTop} bottom=${next.safeBottom} ` +
                    `left=${next.safeLeft} right=${next.safeRight}${next.abnormal ? ' [宽高比异常，走兜底]' : ''}`,
            );
        }

        next.changed = changed;
        this._layout = next;
        return next;
    }

    /**
     * 计算布局参数。
     *
     * @param resolve 是否读取真实屏幕尺寸（true）；false 时用设计基准比例估算
     */
    private _compute(resolve: boolean): PortraitLayout {
        const designW = AppConfig.DESIGN_WIDTH;

        // 屏幕尺寸：wx.getSystemInfoSync 的同步值优先，兜底 cc.screen.windowSize
        const info = this._readScreen(resolve);
        const rawW = info ? info.width : designW;
        const rawH = info ? info.height : AppConfig.DESIGN_HEIGHT;

        // 高宽比：竖版机型应 ≥ 1；若拿到横屏/异常数据，按竖版兜底（取基准比例）
        let aspect = rawW > 0 ? rawH / rawW : AppConfig.DESIGN_HEIGHT / designW;
        let abnormal = false;
        if (!isFinite(aspect) || aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
            // 异常数据不硬闯 —— 退回基准比例，保证界面仍然可用（不裁切、不塌陷）
            abnormal = true;
            aspect = AppConfig.DESIGN_HEIGHT / designW;
            console.warn(
                `[PortraitAdapter] 屏幕尺寸异常（${rawW}x${rawH}，比例 ${aspect.toFixed(3)}），` +
                    `改用基准比例 ${aspect.toFixed(3)}`,
            );
        }

        // 动态设计高度：宽度基准 720 × 机型真实比例，取整到偶数（避免半像素文字模糊）
        let designH = Math.round(designW * aspect);
        designH = Math.max(designW, designH - (designH % 2 === 1 ? 1 : 0));

        // ---- 安全区换算（物理/逻辑 px → 设计坐标系）----
        // FIXED_WIDTH 下横向缩放比 k = designW / screenWidth
        const k = rawW > 0 ? designW / rawW : 1;
        let safeTop = 0;
        let safeBottom = 0;
        let safeLeft = 0;
        let safeRight = 0;
        let hasSafeArea = false;

        if (info && info.safeArea && info.width > 0 && info.height > 0) {
            const sa = info.safeArea;
            const saTop = Number(sa.top) || 0;
            const saBottom = Number(sa.bottom) || 0;
            const saLeft = Number(sa.left) || 0;
            const saRight = Number(sa.right) || 0;
            if (saRight > saLeft && saBottom > saTop) {
                hasSafeArea = true;
                safeTop = Math.max(0, Math.round(saTop * k));
                // ⚠️ 底边避让 = 屏高 - 安全底边坐标，不是 safeArea.bottom 本身
                safeBottom = Math.max(0, Math.round((info.height - saBottom) * k));
                safeLeft = Math.max(0, Math.round(saLeft * k));
                safeRight = Math.max(0, Math.round((info.width - saRight) * k));
            }
        }

        // 拿不到有效安全区时：用兜底值（Mock 全屏 / 数据缺失），保证标题不贴边
        if (!hasSafeArea) {
            safeTop = Math.round(FALLBACK_TOP * k);
            safeBottom = Math.round(FALLBACK_BOTTOM * k);
        }

        // 下限保护：避让值不能吃掉整个屏幕（异常数据可能导致 safeTop 巨大）
        const maxTop = Math.max(0, designH - 200);
        if (safeTop > maxTop) safeTop = maxTop;
        if (safeBottom > maxTop) safeBottom = maxTop;
        if (safeLeft > designW / 4) safeLeft = Math.round(designW / 4);
        if (safeRight > designW / 4) safeRight = Math.round(designW / 4);

        const topY = designH / 2;
        const bottomY = -designH / 2;
        const safeTopY = topY - safeTop;
        const safeBottomY = bottomY + safeBottom;
        const safeH = Math.max(0, designH - safeTop - safeBottom);
        const safeW = Math.max(0, designW - safeLeft - safeRight);

        return {
            designW,
            designH,
            aspect,
            changed: false,
            safeTop,
            safeBottom,
            safeLeft,
            safeRight,
            safeH,
            safeW,
            // safeH 内若上下避让不等，内容中心要跟着偏移，否则视觉上会偏
            safeCenterY: (safeTopY + safeBottomY) / 2,
            topY,
            bottomY,
            safeTopY,
            safeBottomY,
            abnormal,
        };
    }

    /**
     * 读取屏幕尺寸与安全区（**同一来源、同一单位** —— 见文件头「单位口径」）。
     *
     * 优先级：
     *   1. 平台服务 `getSystemInfo()`：screenWidth/Height 与 safeArea 都是逻辑 px，
     *      天然同单位，换算比值可靠；
     *   2. 兜底 `screen.windowSize` + `sys.getSafeAreaRect()` 反推：
     *      windowSize 与 getSafeAreaRect 都按当前设计分辨率换算，比值仍一致。
     *
     * ⚠️ 绝不允许「尺寸取 A 来源、安全区取 B 来源」混用 —— 单位不同会把
     * 侧边/上下避让算成荒谬的值（本项目历史坑）。
     */
    private _readScreen(resolve: boolean): {
        width: number;
        height: number;
        safeArea: { top: number; bottom: number; left: number; right: number } | null;
    } | null {
        if (!resolve) {
            return null;
        }
        // ---- 来源 1：平台服务（逻辑 px，尺寸与安全区同源） ----
        const info = this._fromPlatform();
        if (info) {
            return info;
        }
        // ---- 来源 2：引擎视口（设计坐标系，尺寸与安全区同源） ----
        try {
            const size = screen.windowSize;
            const w = size && size.width > 0 ? size.width : 0;
            const h = size && size.height > 0 ? size.height : 0;
            if (w > 0 && h > 0) {
                return { width: w, height: h, safeArea: this._fromRect() };
            }
        } catch (err) {
            console.warn('[PortraitAdapter] 读取屏幕尺寸失败（忽略）:', err);
        }
        return null;
    }

    /**
     * 从平台服务读屏幕尺寸 + 原始 safeArea（两者同为逻辑 px）。
     *
     * 注意：这里**不用** `sys.getSafeAreaRect()` —— 它返回的是当前设计坐标系的值，
     * 而本模块会**重设**设计分辨率，与平台原始值混用单位会算错。
     */
    private _fromPlatform(): {
        width: number;
        height: number;
        safeArea: { top: number; bottom: number; left: number; right: number } | null;
    } | null {
        try {
            const platform = services.platform;
            if (!platform || typeof platform.getSystemInfo !== 'function') return null;
            const info = platform.getSystemInfo();
            const w = Number(info && info.screenWidth) || 0;
            const h = Number(info && info.screenHeight) || 0;
            if (w <= 0 || h <= 0) return null;
            let sa: { top: number; bottom: number; left: number; right: number } | null = null;
            const raw = info.safeArea;
            if (raw) {
                const t = Number(raw.top) || 0;
                const b = Number(raw.bottom) || 0;
                const l = Number(raw.left) || 0;
                const r = Number(raw.right) || 0;
                // 合法性检查：safeArea 是矩形，右下角必须大于左上角
                if (r > l && b > t) {
                    sa = { top: t, bottom: b, left: l, right: r };
                }
            }
            return { width: w, height: h, safeArea: sa };
        } catch (err) {
            return null;
        }
    }

    /**
     * 兜底：从 cc 的 SafeAreaRect 反推避让值。
     *
     * getSafeAreaRect 与 windowSize 都是当前设计坐标系下的值，**同单位可比**；
     * 换算出的 k=designW/screenW 对两者同样成立，口径一致。
     * 平台服务缺席时（理论上只在初始化异常时走到）用这一路。
     */
    private _fromRect(): {
        top: number;
        bottom: number;
        left: number;
        right: number;
    } | null {
        try {
            const rect = sys.getSafeAreaRect();
            if (!rect) return null;
            const vis = view.getVisibleSize();
            const top = Math.max(0, vis.height - (rect.y + rect.height));
            const bottom = Math.max(0, rect.y);
            const left = Math.max(0, rect.x);
            const right = Math.max(0, vis.width - (rect.x + rect.width));
            if (top === 0 && bottom === 0 && left === 0 && right === 0) return null;
            return { top, bottom, left, right };
        } catch (err) {
            return null;
        }
    }

    // ==================== 便捷查询（供场景排布使用） ====================

    /**
     * 中部内容的「可用竖带」：安全区内边缘再让出上下贴边条的高度。
     *
     * reserveTop / reserveBottom 传贴边条高度（Header 152 / Hud 248 /
     * ActionBar 168 / BtnBar 200 / Footer 96 …）。
     */
    public band(reserveTop: number, reserveBottom: number): { top: number; bottom: number } {
        const L = this.layout;
        return {
            top: L.safeTopY - reserveTop,
            bottom: L.safeBottomY + reserveBottom,
        };
    }

    /**
     * 把一个节点纵向收进上下带之间：**放得下就不动**，放不下才收缩 + 夹位。
     *
     * 语义保证：基准机型（720×1280，原设计即按它书写）永远命中「放得下」
     * 分支 ⇒ 零改动；只有更矮的机型（如 iPad 竖屏 designH≈960）才会被收缩。
     */
    public fitNodeInBand(node: Node, reserveTop: number, reserveBottom: number): void {
        const ut = node.getComponent(UITransform);
        if (!ut) return;
        const { top, bottom } = this.band(reserveTop, reserveBottom);
        const half = ut.height / 2;
        const cy = node.position.y;
        if (cy + half <= top && cy - half >= bottom) return; // 放得下：原样保留
        const avail = Math.max(120, top - bottom);
        ut.height = Math.min(ut.height, avail);
        const nh = ut.height / 2;
        const nc = ut.height >= avail
            ? (top + bottom) / 2                    // 收缩到刚好填满带子 → 居中
            : Math.min(Math.max(cy, bottom + nh), top - nh); // 只是出界 → 拉回带内
        node.setPosition(node.position.x, nc, node.position.z);
    }

    /**
     * 把一组节点当作整体收进上下带之间：**先平移，放不下再按比例压缩**。
     *
     * 用于 Room 的「座位卡 + VS + 状态」列：
     *   · 整体放得下 → 零改动（基准机型即此分支）；
     *   · 出界但带子装得下列总高 → 整列平移到带中心（间距不变）；
     *   · 带子比列总高还矮（iPad 竖屏 designH≈960）→ 各节点高度与相对
     *     间距按同一比例 s 压缩（卡片内子节点偏移 ±50 < 压缩后半高 91，
     *     不会被顶出卡片），保证「任何比例都无重叠」。
     */
    public fitBlockInBand(nodes: Node[], reserveTop: number, reserveBottom: number): void {
        const measured: Array<{ n: Node; ut: UITransform; h: number; cy: number }> = [];
        for (const n of nodes) {
            const ut = n.getComponent(UITransform);
            if (!ut) return;
            measured.push({ n, ut, h: ut.height, cy: n.position.y });
        }
        if (measured.length === 0) return;
        let topEdge = -Infinity;
        let bottomEdge = Infinity;
        for (const m of measured) {
            topEdge = Math.max(topEdge, m.cy + m.h / 2);
            bottomEdge = Math.min(bottomEdge, m.cy - m.h / 2);
        }
        const { top, bottom } = this.band(reserveTop, reserveBottom);
        if (topEdge <= top && bottomEdge >= bottom) return; // 放得下：原样保留
        const blockCenter = (topEdge + bottomEdge) / 2;
        const totalH = topEdge - bottomEdge;
        const bandH = top - bottom;
        const s = Math.min(1, bandH / totalH); // 列比带子高才压缩
        const center = (top + bottom) / 2;
        for (const m of measured) {
            m.ut.height = Math.max(24, Math.round(m.h * s));
            m.n.setPosition(m.n.position.x, center + (m.cy - blockCenter) * s, m.n.position.z);
        }
    }

    /**
     * 把安全区避让推给场景里「贴边条」的 Widget（Header/Footer/Hud/ActionBar/BtnBar）。
     *
     * 判定规则（无需节点名单，按 Widget 对齐位自动识别）：
     *   · 只贴一条横边（TOP 或 BOTTOM，二选一）→ 贴边条：
     *     把它的 top/bottom 从 0 改为安全区避让值，内容就躲开刘海/Home 条；
     *   · 上下都贴（如 Bg、Canvas）→ 全屏拉伸件：**不改**。
     *     背景必须连刘海区一起铺满，否则屏幕上下会露出黑边。
     *
     * 必须在 apply() 之后调用（要用它算出的布局值）。
     */
    public applyEdgeInsets(from: Node): void {
        const L = this.layout;
        // 从传入节点向上找到 Canvas（场景组件挂在 Canvas 的子节点上）
        let root: Node = from;
        while (root.parent) root = root.parent;

        const stack: Node[] = [root];
        while (stack.length > 0) {
            const n = stack.pop() as Node;
            const w = n.getComponent(Widget);
            if (w) {
                const top = w.isAlignTop;
                const bot = w.isAlignBottom;
                if (top && !bot) {
                    w.top = L.safeTop;
                    w.updateAlignment();
                } else if (bot && !top) {
                    w.bottom = L.safeBottom;
                    w.updateAlignment();
                }
                // top && bot：全屏件，保持贴到物理屏幕边缘
            }
            for (const c of n.children) stack.push(c);
        }
    }

    /** 安全区内可用高度。 */
    public get safeHeight(): number {
        return this.layout.safeH;
    }

    /** 安全区内可用宽度。 */
    public get safeWidth(): number {
        return this.layout.safeW;
    }

    /** 顶部安全边缘 y。 */
    public get safeTopY(): number {
        return this.layout.safeTopY;
    }

    /** 底部安全边缘 y。 */
    public get safeBottomY(): number {
        return this.layout.safeBottomY;
    }
}

/** 全局单例。 */
export const portraitAdapter = PortraitAdapter.instance;
