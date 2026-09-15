/**
 * scene-builder.js —— 把「节点树描述」编译成 Cocos `.scene` 序列化数组。
 *
 * 设计要点（每条都对应一次真实踩坑）：
 *
 *  1. `__id__` 是【数组下标】。所以不能一边 push 一边写引用 ——
 *     必须分两遍：先建好全部对象并记录「名字 -> 下标」，再回填引用。
 *  2. 节点/组件 `_id` 用 22 位压缩 uuid；只有 `cc.Scene._id` 是 36 位。
 *  3. Camera 节点在 DEFAULT 层；Canvas / UI 节点在 UI_2D 层。
 *  4. 脚本组件 `__type__` 用脚本压缩 uuid（非 ccclass 名）。
 *  5. 末尾固定跟 cc.SceneGlobals + 7 个子信息。
 *
 * 用法：见 tools/gen-scenes.js
 */

/** 层常量 */
const LAYER_DEFAULT = 1 << 30; // 1073741824
const LAYER_UI_2D = 1 << 25;   // 33554432
const LAYER_UI_3D = 1 << 24;   // 16777216
const CAM_VISIBILITY = LAYER_UI_2D | LAYER_UI_3D; // 41943040

/** 稳定 36 位 uuid（只用于 cc.Scene._id） */
function stableUuid(name, suffix) {
    let hash = 2166136261;
    const s = `${name}:${suffix}`;
    for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const h = (hash >>> 0).toString(16).padStart(8, '0');
    const h2 = ((hash >>> 8) >>> 0).toString(16).padStart(8, '0');
    return `${h}-${h2.slice(0, 4)}-4${h2.slice(4, 7)}-a${h.slice(0, 3)}-${h}${h2}`.slice(0, 36);
}

/** 稳定 22 位压缩 uuid（节点 / 组件 _id） */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function compressedUuid(name, suffix) {
    let h = 5381;
    const s = `${name}:${suffix}`;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    const next = (i) => {
        h ^= h << 13; h >>>= 0;
        h ^= h >> 17;
        h ^= h << 5; h >>>= 0;
        return (h + i * 2654435761) >>> 0;
    };
    let out = '';
    for (let i = 0; i < 20; i++) out += B64_CHARS[next(i) % 64];
    return B64_CHARS[4] + B64_CHARS[0] + out;
}

// ---------------- 值构造器 ----------------

const v3 = (x = 0, y = 0, z = 0) => ({ __type__: 'cc.Vec3', x, y, z });
const quat = () => ({ __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 });
const v2 = (x = 0, y = 0) => ({ __type__: 'cc.Vec2', x, y });
const color = (r, g, b, a = 255) => ({ __type__: 'cc.Color', r, g, b, a });
const size = (width, height) => ({ __type__: 'cc.Size', width, height });
const rect = (x = 0, y = 0, width = 1, height = 1) => ({ __type__: 'cc.Rect', x, y, width, height });
const v4 = (x, y, z, w) => ({ __type__: 'cc.Vec4', x, y, z, w });

function hexToColor(hex, a = 255) {
    const s = hex.replace('#', '');
    return color(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), a);
}

// ---------------- 组件工厂 ----------------

/** UITransform */
function uiTransform(w, h, anchorX = 0.5, anchorY = 0.5) {
    return {
        __type__: 'cc.UITransform',
        _contentSize: size(w, h),
        _anchorPoint: v2(anchorX, anchorY),
    };
}

/**
 * Label —— 字段名已对引擎源码 cocos/2d/components/label.ts 核对。
 * 枚举取数值字面量（与引擎 enum 值一致）：
 *   HorizontalTextAlignment: LEFT=0 CENTER=1 RIGHT=2
 *   VerticalTextAlignment:   TOP=0 CENTER=1 BOTTOM=2
 *   Overflow:                NONE=0 CLAMP=1 SHRINK=2 RESIZE_HEIGHT=3
 *   CacheMode:               NONE=0 BITMAP=1 CHAR=2
 */
function label(opts) {
    const {
        string = 'Label',
        fontSize = 40,
        lineHeight = null,
        colorHex = '#FFFFFF',
        horizontalAlign = 1,
        verticalAlign = 1,
        overflow = 0,
        enableWrapText = true,
        isBold = false,
        fontFamily = 'Arial',
    } = opts || {};
    return {
        __type__: 'cc.Label',
        _string: string,
        _horizontalAlign: horizontalAlign,
        _verticalAlign: verticalAlign,
        _actualFontSize: fontSize,
        _fontSize: fontSize,
        _fontFamily: fontFamily,
        _lineHeight: lineHeight === null ? fontSize : lineHeight,
        _overflow: overflow,
        _enableWrapText: enableWrapText,
        _font: null,
        _isSystemFontUsed: true,
        _spacingX: 0,
        _isItalic: false,
        _isBold: isBold,
        _isUnderline: false,
        _underlineHeight: 2,
        _cacheMode: 0,
        _enableOutline: false,
        _outlineColor: color(0, 0, 0, 255),
        _outlineWidth: 2,
        _enableShadow: false,
        _shadowColor: color(0, 0, 0, 255),
        _shadowOffset: v2(2, 2),
        _shadowBlur: 2,
        _color: hexToColor(colorHex),
    };
}

/**
 * Graphics —— 用于纯色块（零美术资源）。
 * 引擎 cocos/2d/components/graphics.ts
 *
 * ️ 重要：Graphics **只序列化颜色/线宽等参数，不序列化已绘制的路径**
 *    （见 graphics.ts 的 @serializable 字段表）。因此把 Graphics 直接写进 .scene
 *    得到的是"空 Graphics"，编辑器与运行时都不显示任何东西 ——
 *    这正是静态 UI 曾"只剩文字、看不到色块"的根因。
 *    需要静态色块请用 `assets/scripts/core/UiFill.ts`（自绘组件，属性可序列化），
 *    见 tools/ui-trees.js 的 fillComp()。
 */
function graphics(colorHex, lineWidth = 1) {
    return {
        __type__: 'cc.Graphics',
        _lineWidth: lineWidth,
        _strokeColor: hexToColor(colorHex),
        _lineJoin: 2,
        _lineCap: 0,
        _fillColor: hexToColor(colorHex),
        _miterLimit: 10,
        _color: hexToColor(colorHex),
    };
}

/**
 * ProgressBar —— 字段已核对 cocos/ui/progress-bar.ts
 * Mode.HORIZONTAL = 0
 */
function progressBar(barSpriteIdx, mode = 0, totalLength = 1, progress = 0.1, reverse = false) {
    return {
        __type__: 'cc.ProgressBar',
        _barSprite: barSpriteIdx === null || barSpriteIdx === undefined ? null : { __id__: barSpriteIdx },
        _mode: mode,
        _totalLength: totalLength,
        _progress: progress,
        _reverse: reverse,
    };
}

/**
 * ScrollView —— 字段已核对 cocos/ui/scroll-view.ts
 */
function scrollView(contentIdx, horizontal = false, vertical = true) {
    return {
        __type__: 'cc.ScrollView',
        content: contentIdx === null || contentIdx === undefined ? null : { __id__: contentIdx },
        _horizontalScrollBar: null,
        _verticalScrollBar: null,
        _horizontal: horizontal,
        _vertical: vertical,
        _inertia: true,
        _brake: 0.5,
        _elastic: true,
        _bounceDuration: 0.23,
        _scrollEvents: [],
        cancelInnerEvents: true,
    };
}

/**
 * Layout —— 字段已核对 cocos/ui/layout.ts
 * LayoutType.VERTICAL = 2 ; ResizeMode.CONTAINER = 1 ; AxisDirection / StartAxis 见引擎枚举
 */
function layout(opts) {
    const {
        type = 2,            // VERTICAL
        resizeMode = 1,      // CONTAINER
        cellSize = null,
        startAxis = 1,       // HORIZONTAL
        paddingLeft = 0,
        paddingRight = 0,
        paddingTop = 0,
        paddingBottom = 0,
        spacingX = 0,
        spacingY = 0,
        verticalDirection = 1,   // TOP_TO_BOTTOM
        horizontalDirection = 0, // LEFT_TO_RIGHT
        affectedByScale = false,
    } = opts || {};
    return {
        __type__: 'cc.Layout',
        _layoutType: type,
        _resizeMode: resizeMode,
        _cellSize: cellSize ? size(cellSize[0], cellSize[1]) : size(40, 40),
        _startAxis: startAxis,
        _paddingLeft: paddingLeft,
        _paddingRight: paddingRight,
        _paddingTop: paddingTop,
        _paddingBottom: paddingBottom,
        _spacingX: spacingX,
        _spacingY: spacingY,
        _verticalDirection: verticalDirection,
        _horizontalDirection: horizontalDirection,
        _affectedByScale: affectedByScale,
        // 引擎实际只有一个 _isAlign 开关（已核对 layout.ts:677）
        _isAlign: false,
    };
}

/**
 * Widget —— 对齐字段已核对（本项目既有场景即用此形态）
 * AlignMode.ON_WINDOW_RESIZE = 2
 */
function widget(opts) {
    const {
        alignFlags = 45, // TOP|BOTTOM|LEFT|RIGHT
        left = 0, right = 0, top = 0, bottom = 0,
        horizontalCenter = 0, verticalCenter = 0,
    } = opts || {};
    return {
        __type__: 'cc.Widget',
        _alignFlags: alignFlags,
        _target: null,
        _left: left,
        _right: right,
        _top: top,
        _bottom: bottom,
        _horizontalCenter: horizontalCenter,
        _verticalCenter: verticalCenter,
        _isAbsLeft: true,
        _isAbsRight: true,
        _isAbsTop: true,
        _isAbsBottom: true,
        _isAbsHorizontalCenter: true,
        _isAbsVerticalCenter: true,
        _originalWidth: 0,
        _originalHeight: 0,
        _alignMode: 2,
        _lockFlags: 0,
    };
}

/**
 * Button —— 字段已核对 cocos/ui/button.ts
 * Transition.NONE = 0
 */
function button() {
    return {
        __type__: 'cc.Button',
        clickEvents: [],
        _interactable: true,
        _transition: 0,
        _normalColor: color(255, 255, 255, 255),
        _hoverColor: color(255, 255, 255, 255),
        _pressedColor: color(255, 255, 255, 255),
        _disabledColor: color(124, 124, 124, 255),
        _normalSprite: null,
        _hoverSprite: null,
        _pressedSprite: null,
        _disabledSprite: null,
        _duration: 0.1,
        _zoomScale: 1.2,
        _target: null,
    };
}

/** Mask（ScrollView 裁剪用）
 * MaskType.GRAPHICS_RECT = 0 ; GRAPHICS_ELLIPSE = 1 ; SPRITE_STENCIL = 2
 */
function mask(type = 0) {
    return {
        __type__: 'cc.Mask',
        _type: type,
        _inverted: false,
        _segments: 64,
    };
}

/** Sprite（ProgressBar 的 fill 需要；用纯白 SpriteFrame 不便生成，故用 Graphics 替代时不需要它） */

/**
 * 节点引用占位。
 *
 * 节点树里要表达「A 的组件引用 B 节点」（如 ScrollView.content）**必须**用本函数。
 * 直接传描述对象会生成 `{"__id__": {整棵节点描述}}` 这种垃圾（曾被静默写进 .scene），
 * 正确形式是编译期解析出的 `{"__id__": <数组下标>}`。
 */
function nodeRef(desc) {
    return { __ref__: desc };
}

// ---------------- 节点树编译 ----------------

/**
 * 把一个「节点树描述」编译成 `.scene` 序列化数组。
 *
 * 描述格式（见 gen-scenes.js）：
 *   node('Name', { pos:[x,y], size:[w,h], anchor:[ax,ay], layer, active },
 *        [ comps... ],
 *        [ children... ])
 */
function makeNode(name, opts, comps, children) {
    const {
        pos = [0, 0],
        size: sz = null,
        anchor = [0.5, 0.5],
        layer = LAYER_UI_2D,
        active = true,
    } = opts || {};
    const list = [];
    if (sz) list.push(uiTransform(sz[0], sz[1], anchor[0], anchor[1]));
    for (const c of (comps || [])) list.push(c);
    return {
        __kind__: 'node',
        name,
        pos,
        layer,
        active,
        comps: list.map(normalizeComp),
        children: children || [],
    };
}

/**
 * 统一组件声明格式：接受
 *   { type: 'cc.Label', body: {...} }          —— 显式形式
 *   { __type__: 'cc.UITransform', ... }        —— 直接传组件值对象（自动包成 type/body）
 *
 * 这个归一化是必须的：早期版本漏了它，导致 comp.type 为 undefined，
 * 生成出「没有 __type__ 的组件对象」，编辑器无法识别。
 */
function normalizeComp(c) {
    if (!c) throw new Error('normalizeComp: 空组件声明');
    if (typeof c.type === 'string') {
        return { type: c.type, body: c.body || {} };
    }
    if (typeof c.__type__ === 'string') {
        const body = {};
        for (const [k, v] of Object.entries(c)) {
            if (k === '__type__') continue;
            body[k] = v;
        }
        return { type: c.__type__, body };
    }
    throw new Error('normalizeComp: 无法识别的组件声明 ' + JSON.stringify(c).slice(0, 80));
}

/**
 * 编译节点树 -> 扁平数组。
 * 返回 { arr, indexOf }；indexOf: 描述对象 -> 数组下标
 */
function compile(sceneName, scriptUuid, rootChildren, scriptNodePath) {
    const arr = [];
    const idx = new Map(); // 描述对象 -> 下标

    // ---- 0/1: SceneAsset + Scene（占位，稍后回填 _children / _globals） ----
    arr.push({
        __type__: 'cc.SceneAsset',
        _name: sceneName,
        _objFlags: 0,
        __editorExtras__: {},
        _native: '',
        scene: { __id__: 1 },
    });
    arr.push({
        __type__: 'cc.Scene',
        _name: sceneName,
        _objFlags: 0,
        __editorExtras__: {},
        _parent: null,
        _children: [],
        _active: true,
        _components: [],
        _prefab: null,
        _lpos: v3(),
        _lrot: quat(),
        _lscale: v3(1, 1, 1),
        _mobility: 0,
        _layer: LAYER_DEFAULT,
        _euler: v3(),
        autoReleaseAssets: false,
        _globals: { __id__: 0 }, // 回填
        _id: stableUuid(sceneName, 'scene'),
    });

    // ---- 递归建节点 + 组件（先占位，引用后回填） ----
    let seq = 0;
    const build = (desc, parentIdx) => {
        const nIdx = arr.length;
        arr.push({
            __type__: 'cc.Node',
            _name: desc.name,
            _objFlags: 0,
            __editorExtras__: {},
            _parent: { __id__: parentIdx },
            _children: [],       // 回填
            _active: desc.active,
            _components: [],     // 回填
            _prefab: null,
            _lpos: v3(desc.pos[0], desc.pos[1], 0),
            _lrot: quat(),
            _lscale: v3(1, 1, 1),
            _mobility: 0,
            _layer: desc.layer,
            _euler: v3(),
            _id: compressedUuid(sceneName, 'node#' + seq + '#' + desc.name),
        });
        seq++;
        idx.set(desc, nIdx);

        // 子节点（先建，保证 parent/child 下标都已确定）
        for (const ch of desc.children) build(ch, nIdx);

        // 组件（依赖同节点下其它组件的下标，故放在子节点之后统一处理）
        const compIdxList = [];
        for (const c of desc.comps) {
            const cIdx = arr.length;
            desc.__compIdx__ = desc.__compIdx__ || [];
            desc.__compIdx__.push(cIdx);
            compIdxList.push(cIdx);
            arr.push({ __pending__: c, __node__: nIdx, __self__: cIdx });
        }
        arr[nIdx]._components = compIdxList.map((i) => ({ __id__: i }));
        arr[nIdx]._children = desc.children.map((ch) => ({ __id__: idx.get(ch) }));
    };

    for (const ch of rootChildren) build(ch, 1); // 1 = Scene
    arr[1]._children = rootChildren.map((ch) => ({ __id__: idx.get(ch) }));

    // ---- 把每个组件的 __pending__ 实体化（此时所有节点下标已定，可安全解析引用） ----
    for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (!o || !o.__pending__) continue;
        const comp = o.__pending__;
        const nodeIdx = o.__node__;
        const selfIdx = o.__self__;

        // 解析该组件声明的「引用占位」
        const resolve = (v) => {
            if (v && typeof v === 'object' && '__ref__' in v) {
                const target = v.__ref__;
                if (target && idx.has(target)) return { __id__: idx.get(target) };
                throw new Error('compile: __ref__ 指向未注册的节点 ' + (target && target.name));
            }
            if (v && typeof v === 'object' && v.__kind__ === 'compRef') {
                // 指向同描述里第 n 个组件
                const owner = v.owner;
                const list = owner.__compIdx__ || [];
                const at = list[v.at];
                if (at === undefined) throw new Error('compile: compRef 越界');
                return { __id__: at };
            }
            if (Array.isArray(v)) return v.map(resolve);
            if (v && typeof v === 'object') {
                const out = {};
                for (const [k, val] of Object.entries(v)) out[k] = resolve(val);
                return out;
            }
            return v;
        };

        const body = resolve(comp.body || {});
        const built = {
            __type__: comp.type,
            _name: '',
            _objFlags: 0,
            __editorExtras__: {},
            node: { __id__: nodeIdx },
            _enabled: true,
            __prefab: null,
            ...body,
            _id: compressedUuid(sceneName, 'comp#' + selfIdx + '#' + comp.type),
        };
        arr[i] = built;
    }

    // ---- Camera 组件（挂在名为 Camera 的节点上；可能在任意深度） ----
    const flatten = (list, acc = []) => {
        for (const n of list) { acc.push(n); if (n.children && n.children.length) flatten(n.children, acc); }
        return acc;
    };
    const allDescs = flatten(rootChildren);
    const camDesc = allDescs.find((c) => c.name === 'Camera');
    if (!camDesc) throw new Error('compile: 缺 Camera 节点');
    const camNodeIdx = idx.get(camDesc);
    const camCompIdx = arr.length;
    arr.push({
        __type__: 'cc.Camera',
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        node: { __id__: camNodeIdx },
        _enabled: true,
        __prefab: null,
        _projection: 0,
        _priority: LAYER_DEFAULT,
        _fov: 45,
        _fovAxis: 0,
        _orthoHeight: 640,
        _near: 1,
        _far: 2000,
        _color: color(0, 0, 0, 255),
        _depth: 1,
        _stencil: 0,
        _clearFlags: 7,
        _rect: rect(),
        _aperture: 19,
        _shutter: 7,
        _iso: 0,
        _screenScale: 1,
        _visibility: CAM_VISIBILITY,
        _targetTexture: null,
        _postProcess: null,
        _usePostProcess: false,
        _cameraType: -1,
        _trackingType: 0,
        _id: compressedUuid(sceneName, 'cameracomp'),
    });
    arr[camNodeIdx]._components.push({ __id__: camCompIdx });

    // ---- Canvas 组件的 _cameraComponent 指向该相机 ----
    const canvasDesc = rootChildren.find((c) => c.name === 'Canvas');
    if (canvasDesc) {
        const canvasList = canvasDesc.__compIdx__ || [];
        for (const ci of canvasList) {
            if (arr[ci] && arr[ci].__type__ === 'cc.Canvas') {
                arr[ci]._cameraComponent = { __id__: camCompIdx };
            }
        }
    }

    // ---- 脚本组件：按路径找到目标节点并挂载 ----
    if (scriptUuid) {
        const target = scriptNodePath(rootChildren, idx);
        if (!target) throw new Error('compile: 未找到脚本挂载节点');
        const sIdx = arr.length;
        arr.push({
            __type__: scriptUuid,
            _name: '',
            _objFlags: 0,
            __editorExtras__: {},
            node: { __id__: idx.get(target) },
            _enabled: true,
            __prefab: null,
            _id: compressedUuid(sceneName, 'ctrl'),
        });
        arr[idx.get(target)]._components.push({ __id__: sIdx });
    }

    // ---- SceneGlobals 及其 7 个子信息 ----
    const gi = arr.length;
    arr.push({
        __type__: 'cc.SceneGlobals',
        ambient: { __id__: gi + 1 },
        shadows: { __id__: gi + 2 },
        _skybox: { __id__: gi + 3 },
        fog: { __id__: gi + 4 },
        octree: { __id__: gi + 5 },
        skin: { __id__: gi + 6 },
        lightProbeInfo: { __id__: gi + 7 },
        bakedWithStationaryMainLight: false,
        bakedWithHighpLightmap: false,
    });
    arr.push({
        __type__: 'cc.AmbientInfo',
        _skyColorHDR: v4(0.2, 0.5, 0.8, 0.52),
        _skyColor: v4(0.2, 0.5, 0.8, 0.52),
        _skyIllumHDR: 20000,
        _skyIllum: 20000,
        _groundAlbedoHDR: v4(0.2, 0.2, 0.2, 1),
        _groundAlbedo: v4(0.2, 0.2, 0.2, 1),
        _skyColorLDR: v4(0.2, 0.5, 0.8, 1),
        _skyIllumLDR: 20000,
        _groundAlbedoLDR: v4(0.2, 0.2, 0.2, 1),
    });
    arr.push({
        __type__: 'cc.ShadowsInfo',
        _enabled: false,
        _type: 0,
        _normal: v3(0, 1, 0),
        _distance: 0,
        _shadowColor: color(76, 76, 76, 255),
        _maxReceived: 4,
        _size: v2(1024, 1024),
    });
    arr.push({
        __type__: 'cc.SkyboxInfo',
        _envLightingType: 0,
        _envmapHDR: null,
        _envmap: null,
        _envmapLDR: null,
        _diffuseMapHDR: null,
        _diffuseMapLDR: null,
        _enabled: false,
        _useHDR: true,
        _editableMaterial: null,
        _reflectionHDR: null,
        _reflectionLDR: null,
        _rotationAngle: 0,
    });
    arr.push({
        __type__: 'cc.FogInfo',
        _type: 0,
        _fogColor: color(200, 200, 200, 255),
        _enabled: false,
        _fogDensity: 0.3,
        _fogStart: 0.5,
        _fogEnd: 300,
        _fogAtten: 5,
        _fogTop: 1.5,
        _fogRange: 1.2,
        _accurate: false,
    });
    arr.push({
        __type__: 'cc.OctreeInfo',
        _enabled: false,
        _minPos: v3(-1024, -1024, -1024),
        _maxPos: v3(1024, 1024, 1024),
        _depth: 8,
    });
    arr.push({
        __type__: 'cc.SkinInfo',
        _enabled: false,
        _blurRadius: 0.01,
        _sssIntensity: 3,
    });
    arr.push({
        __type__: 'cc.LightProbeInfo',
        _giScale: 1,
        _giSamples: 1024,
        _bounces: 2,
        _reduceRinging: 0,
        _showProbe: true,
        _showWireframe: true,
        _showConvex: false,
        _data: null,
        _lightProbeSphereVolume: 1,
    });

    // 回填 Scene._globals
    arr[1]._globals = { __id__: gi };

    return { arr, idx };
}

module.exports = {
    LAYER_DEFAULT,
    LAYER_UI_2D,
    LAYER_UI_3D,
    CAM_VISIBILITY,
    stableUuid,
    compressedUuid,
    v3, v2, v4, quat, color, size, rect, hexToColor,
    uiTransform, label, graphics, progressBar, scrollView, layout, widget, button, mask,
    nodeRef,
    makeNode,
    normalizeComp,
    compile,
};
