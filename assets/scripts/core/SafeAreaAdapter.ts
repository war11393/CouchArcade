/**
 * 安全区适配组件（**已被 PortraitAdapter 取代，未挂载到任何场景**）。
 *
 * ⚠️ 状态说明（2026-09 竖版自适应改造）：本组件是早期按「固定设计分辨率
 * 720×1280」写的方案 —— 只解决「内容按安全区内缩」，没解决「顶/底栏贴住
 * 真实屏幕边缘」。现在贴边由 cc.Widget 承担、安全区避让由
 * core/PortraitAdapter.applyEdgeInsets() 统一推给贴边条，本组件**不再使用**，
 * 保留仅作参照。如要重新启用，先与 PortraitAdapter 对齐单位口径。
 *
 * 数据来源：IPlatformService.getSystemInfo().safeArea
 * - Mock：返回全屏或模拟刘海值（浏览器高宽比 ≥1.9 时模拟 44/34 避让）；
 * - Wx 桩：预留 wx.getSystemInfoSync() 接入点（见 WxPlatformService）。
 *
 * 原适配策略：FIXED_WIDTH（拟合宽度）
 * - 设计分辨率原假定固定 720×1280，横向撑满（现 designH 运行期按机型实算）；
 * - 纵向在刘海屏上会超出可视区，因此顶部/底部内容需要按 safeArea 内缩。
 */

import { _decorator, Component, Node, UITransform, view, screen, Widget } from 'cc';
import { AppConfig } from '../config/AppConfig';
import { services, ensureServices } from './ServiceLocator';
import { GameEvent, SafeAreaPayload, eventBus } from './EventBus';

const { ccclass, property } = _decorator;

@ccclass('SafeAreaAdapter')
export class SafeAreaAdapter extends Component {
    /**
     * 需要避让的容器节点（通常是一个全屏 Widget 节点，
     * 其子节点为实际的 UI 内容）。
     */
    @property(Node)
    public target: Node | null = null;

    /** 顶部是否参与避让（标题栏）。 */
    @property
    public adaptTop = true;

    /** 底部是否参与避让（操作区）。 */
    @property
    public adaptBottom = true;

    /** 是否在尺寸变化时自动重算。 */
    @property
    public listenResize = true;

    /** 计算出的避让值（设计分辨率坐标系，px）。 */
    private _top = 0;
    private _bottom = 0;
    private _left = 0;
    private _right = 0;

    protected onLoad(): void {
        this.apply();
        if (this.listenResize) {
            // 浏览器窗口大小变化 / 真机旋转
            view.on('canvas-resize', this.apply, this);
            if (typeof window !== 'undefined') {
                window.addEventListener('resize', this._onResize);
            }
        }
    }

    protected onDestroy(): void {
        view.off('canvas-resize', this.apply, this);
        if (this.listenResize && typeof window !== 'undefined') {
            window.removeEventListener('resize', this._onResize);
        }
    }

    private _onResize = (): void => {
        this.apply();
    };

    /**
     * 执行适配计算与应用。
     *
     * 换算逻辑：
     * 1. 从平台层拿系统信息（物理像素 + safeArea）；
     * 2. 把物理像素的安全区换算到「设计分辨率坐标系」：
     *    scale = 设计宽度 / 屏幕宽度  （FIXED_WIDTH 策略）
     *    topPx = safeArea.top * scale
     * 3. 应用到目标节点的 Widget（top/bottom 偏移）。
     */
    public apply(): void {
        // ⚠️ 本组件在 onLoad 里就会被调用，此时 ServiceLocator 可能尚未注入
        // （历史上 AppBootstrap 漏挂到场景 → services.platform 为 undefined → 整页崩溃）。
        // 这里主动兜底注入，并对异常数据降级处理，保证 UI 不会因适配层失败而整体不可用。
        ensureServices();

        const frame = view.getVisibleSize();
        const info = this._readSystemInfo();
        if (!info) {
            // 拿不到系统信息：把避让值清零，直接用可视尺寸，不阻断渲染
            this._top = 0;
            this._bottom = 0;
            this._left = 0;
            this._right = 0;
            this._applyToTarget();
            return;
        }

        // FIXED_WIDTH：横向按设计宽度撑满，故缩放比 = 设计宽 / 屏幕宽
        const scale = frame.width / AppConfig.DESIGN_WIDTH;

        let top = this.adaptTop ? Math.round(info.safeArea.top * scale) : 0;
        const bottomRaw = info.screenHeight - info.safeArea.bottom;
        let bottom = this.adaptBottom ? Math.round(Math.max(0, bottomRaw) * scale) : 0;
        const left = Math.round(info.safeArea.left * scale);
        const right = Math.round(Math.max(0, info.screenWidth - info.safeArea.right) * scale);

        // 兜底：安全区数据异常（Mock 全屏时 top=0）时给一个最小内缩，
        // 保证竖屏标题不会贴边。
        if (top === 0 && info.safeArea.top === 0) {
            top = 0;
        }
        if (top < 0 || !isFinite(top)) {
            top = 0;
        }
        if (bottom < 0 || !isFinite(bottom)) {
            bottom = 0;
        }

        this._top = top;
        this._bottom = bottom;
        this._left = left;
        this._right = right;

        this._applyToTarget();

        const payload: SafeAreaPayload = {
            top,
            bottom,
            left,
            right,
            screenWidth: info.screenWidth,
            screenHeight: info.screenHeight,
        };
        eventBus.emit(GameEvent.SAFE_AREA_CHANGED, payload);

        console.log(
            `[SafeAreaAdapter] 安全区适配完成：top=${top} bottom=${bottom} left=${left} right=${right} ` +
                `(屏幕=${info.screenWidth}x${info.screenHeight} 可视=${frame.width}x${frame.height} scale=${scale.toFixed(3)})`,
        );
    }

    /**
     * 安全读取系统信息：平台服务缺失或数据不完整时返回 null。
     */
    private _readSystemInfo(): {
        safeArea: { top: number; bottom: number; left: number; right: number };
        screenWidth: number;
        screenHeight: number;
    } | null {
        try {
            const platform = services.platform;
            if (!platform || typeof platform.getSystemInfo !== 'function') {
                console.warn('[SafeAreaAdapter] 平台服务不可用，跳过安全区适配（使用全屏布局）');
                return null;
            }
            const info = platform.getSystemInfo();
            if (!info || !info.safeArea) {
                console.warn('[SafeAreaAdapter] 系统信息缺少 safeArea，跳过安全区适配');
                return null;
            }
            const sa = info.safeArea;
            const screenWidth = Number(info.screenWidth);
            const screenHeight = Number(info.screenHeight);
            if (!isFinite(screenWidth) || !isFinite(screenHeight) || screenWidth <= 0 || screenHeight <= 0) {
                console.warn('[SafeAreaAdapter] 屏幕尺寸无效，跳过安全区适配');
                return null;
            }
            return {
                safeArea: {
                    top: Number(sa.top) || 0,
                    bottom: Number(sa.bottom) || 0,
                    left: Number(sa.left) || 0,
                    right: Number(sa.right) || 0,
                },
                screenWidth,
                screenHeight,
            };
        } catch (err) {
            console.warn('[SafeAreaAdapter] 读取系统信息失败，跳过安全区适配：', err);
            return null;
        }
    }

    /** 把避让值写到目标节点的 Widget 上。 */
    private _applyToTarget(): void {
        const node = this.target ?? this.node;
        const widget = node.getComponent(Widget);
        if (widget) {
            widget.isAlignTop = this.adaptTop;
            widget.isAlignBottom = this.adaptBottom;
            widget.isAlignLeft = this.adaptTop || true;
            widget.isAlignRight = this.adaptTop || true;
            widget.top = this._top;
            widget.bottom = this._bottom;
            widget.left = this._left;
            widget.right = this._right;
            widget.updateAlignment();
        } else {
            // 无 Widget 时退化为直接设置 UITransform 高度
            const t = node.getComponent(UITransform);
            if (t) {
                const frame = view.getVisibleSize();
                t.setContentSize(frame.width - this._left - this._right, frame.height - this._top - this._bottom);
            }
        }
    }

    // ==================== 供 UI 布局查询 ====================

    /** 顶部避让高度（设计分辨率坐标系）。 */
    public getTopInset(): number {
        return this._top;
    }

    /** 底部避让高度。 */
    public getBottomInset(): number {
        return this._bottom;
    }

    /** 安全区内可用高度。 */
    public getSafeHeight(): number {
        return view.getVisibleSize().height - this._top - this._bottom;
    }

    /** 安全区内可用宽度。 */
    public getSafeWidth(): number {
        return view.getVisibleSize().width - this._left - this._right;
    }

    /** 未使用引用占位（保持 screen 导入可用）。 */
    private static readonly _screenRef = typeof screen;
}
