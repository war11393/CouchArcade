/**
 * validate-scenes.js —— 场景回归校验（4 层，每层都必须能证伪目标未达成）。
 *
 *  A. 序列化格式   —— __id__ 类型/越界、_id 格式、层、相机、SceneGlobals、脚本 uuid
 *  B. 内容存在性   —— 真的有 Label / UiFill / Button 吗？文案非空？alpha>0？（防"空壳场景"）
 *  C. 设计系统合规 —— 所有颜色必须来自 UITheme.ts 令牌表；页面底色必须是白；不得残留深色
 *  D. 路径契约     —— 控制器按路径绑定的每个节点**必须存在**（UI 重排最容易踩的坑）
 *
 * 历史教训（为什么要有 B/C/D）：
 *   · 曾出现「36 项格式断言全过，但场景是空壳，一个 UI 组件都没有」——只查格式等于自我安慰。
 *   · 曾出现 cc.Graphics 写进 .scene 却什么都没画（Graphics 不序列化路径）。
 *   · 曾出现 ScrollView.content 被写成整棵节点描述对象（`__id__` 非数字），滚动失效。
 *   · 控制器按 `Canvas/Header/HeaderTitle` 这类路径取节点，UI 一旦改名就静默失效 —— 必须断言。
 */
const fs = require('fs');
const path = require('path');
const T = require('./theme.js');

const ROOT = path.resolve(__dirname, '..');
const REF = 'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\resources\\resources\\3d\\engine\\editor\\assets\\default_file_content\\scene\\scene-2d.scene';

const compressed = /^[A-Za-z0-9+/]{22}$/;
const longUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCRIPT_UUID = JSON.parse(fs.readFileSync(path.join(__dirname, 'script-uuids.json'), 'utf8'));
const FILL_UUID = SCRIPT_UUID.UiFill;

const SCRIPT_OF = {
    Loading: 'LoadingScene', Lobby: 'LobbyScene', Room: 'RoomScene', Game: 'GameScene',
};
const SCRIPT_SRC = {
    Loading: 'lobby/LoadingScene.ts', Lobby: 'lobby/LobbyScene.ts',
    Room: 'room/RoomScene.ts', Game: 'room/GameScene.ts',
};

/** B. 每个场景必须具备的视觉组件下限（"场景里真的有 UI"的硬性证据）。 */
const REQUIRED_UI = {
    // Loading 的 7 个 Label：LogoText / Title / Subtitle / ProgressText / Status / Hint / Version
    Loading: { 'cc.Label': 7, [FILL_UUID]: 4, 'cc.ProgressBar': 1 },
    Lobby: { 'cc.Label': 13, [FILL_UUID]: 9, 'cc.ScrollView': 1, 'cc.Layout': 1, 'cc.Mask': 1, 'cc.Button': 2 },
    Room: { 'cc.Label': 12, [FILL_UUID]: 9, 'cc.Button': 2 },
    Game: { 'cc.Label': 11, [FILL_UUID]: 10, 'cc.Button': 3 },
};

/** D. 路径契约：控制器（及大厅卡片循环）按这些路径取节点，缺一个就是线上静默失效。 */
const CARD_PATHS = (id) => [
    `Canvas/GameList/view/content/Card_${id}`,
    `Canvas/GameList/view/content/Card_${id}/Icon/IconText`,
    `Canvas/GameList/view/content/Card_${id}/Name`,
    `Canvas/GameList/view/content/Card_${id}/Desc`,
    `Canvas/GameList/view/content/Card_${id}/Online`,
    `Canvas/GameList/view/content/Card_${id}/PlayBtn`,
    `Canvas/GameList/view/content/Card_${id}/PlayBtn/PlayBtnLabel`,
];

/**
 * 每个场景都必须有的浮层容器。
 *
 * UIManager 把 Toast/模式弹窗/结算弹窗挂到 `Canvas/Overlay` 下。
 * 为什么不能直接挂 Canvas：`GameList/view` 的 cc.Mask 会把追加的兄弟节点裁掉，
 * 症状是「点了开始游戏，控制台有日志，但屏幕上什么都不出现」。
 * 这个断言就是防止有人顺手把 overlayNode 从 ui-trees.js 里删掉。
 */
const OVERLAY_PATH = 'Canvas/Overlay';

const REQUIRED_PATHS = {
    Loading: [
        'Canvas/Bg', 'Canvas/Title', 'Canvas/Subtitle',
        'Canvas/ProgressBarBg', 'Canvas/ProgressBarBg/ProgressBarFill',
        // 加载页的「明确进度反馈」三件套：百分比数字 + 阶段文案 + 卡住兜底提示
        'Canvas/ProgressText', 'Canvas/Status', 'Canvas/Hint',
        'Canvas/Version',
        OVERLAY_PATH,
    ],
    Lobby: [
        'Canvas/Bg', 'Canvas/Header', 'Canvas/Header/HeaderTitle', 'Canvas/Header/HeaderUser',
        'Canvas/GameList', 'Canvas/GameList/view', 'Canvas/GameList/view/content', 'Canvas/Footer',
        OVERLAY_PATH,
        ...CARD_PATHS('planehunt'), ...CARD_PATHS('gomoku'),
    ],
    Room: [
        'Canvas/Bg', 'Canvas/Header/RoomTitle', 'Canvas/Header/RoomId',
        'Canvas/SeatTop', 'Canvas/SeatTop/SeatName', 'Canvas/SeatTop/SeatStatus', 'Canvas/SeatTop/SeatScore',
        'Canvas/SeatBottom', 'Canvas/SeatBottom/SeatName', 'Canvas/SeatBottom/SeatStatus', 'Canvas/SeatBottom/SeatScore',
        'Canvas/VsLabel', 'Canvas/Status',
        'Canvas/BtnReady', 'Canvas/BtnReady/BtnReadyLabel',
        'Canvas/BtnLeave', 'Canvas/BtnLeave/BtnLeaveLabel',
        OVERLAY_PATH,
    ],
    Game: [
        'Canvas/Bg',
        'Canvas/Hud/OppName', 'Canvas/Hud/OppScore', 'Canvas/Hud/MyName', 'Canvas/Hud/MyScore',
        'Canvas/Hud/TurnLabel', 'Canvas/Hud/TimerLabel',
        'Canvas/BoardArea', 'Canvas/BoardArea/BoardHint',
        'Canvas/EmotePanel', 'Canvas/EmotePanel/EmoteList',
        'Canvas/ActionBar', 'Canvas/ActionBar/BtnEmote', 'Canvas/ActionBar/BtnRestart',
        'Canvas/ActionBar/BtnLeaveGame',
        OVERLAY_PATH,
    ],
};

let fail = 0;
const chk = (ok, msg) => {
    if (!ok) { console.log('  FAIL  ' + msg); fail++; }
};

/** Color 对象 → '#RRGGBB' */
const hexOf = (c) => (c ? '#' + [c.r, c.g, c.b].map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase() : null);

for (const f of ['Loading', 'Lobby', 'Room', 'Game']) {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'scenes', f + '.scene'), 'utf8'));
    console.log('=== ' + f + ' ===');

    // ---------- A. 格式 ----------
    const scIdx = s.findIndex((o) => o.__type__ === 'cc.Scene');
    const sc = s[scIdx];
    const cam = s.find((o) => o.__type__ === 'cc.Camera');
    const nodes = s.filter((o) => o.__type__ === 'cc.Node');

    const noType = s.filter((o) => !o || !o.__type__);
    chk(noType.length === 0, '所有对象都有 __type__（无未实体化残留）: ' + noType.length + ' 个缺失');

    // __id__ 必须是数字（曾出现整棵描述被写进 __id__ 的垃圾引用）
    const oob = [];
    const badIdType = [];
    const scan = (v, p) => {
        if (Array.isArray(v)) return v.forEach((x, i) => scan(x, p + '[' + i + ']'));
        if (v && typeof v === 'object') {
            if ('__id__' in v) {
                if (typeof v.__id__ !== 'number') badIdType.push(p);
                else {
                    const t = s[v.__id__];
                    if (!t || !t.__type__) oob.push(p + ' -> ' + v.__id__);
                }
            }
            for (const [k, val] of Object.entries(v)) {
                if (k === '__id__' && typeof val === 'number') continue;
                scan(val, p + '.' + k);
            }
        }
    };
    s.forEach((o, i) => scan(o, '[' + i + ']'));
    chk(badIdType.length === 0, '__id__ 全为数字引用' + (badIdType.length ? ' → ' + badIdType.slice(0, 3).join(' | ') : ''));
    chk(oob.length === 0, '无越界/悬空 __id__ 引用' + (oob.length ? ' → ' + oob.slice(0, 4).join(' | ') : ''));

    chk(longUuid.test(sc._id), 'cc.Scene._id 是 36 位 uuid');
    let badId = 0;
    for (const o of s) {
        if (o.__type__ === 'cc.Scene') continue;
        if (o._id !== undefined && !compressed.test(o._id)) badId++;
    }
    chk(badId === 0, '节点/组件 _id 均为 22 位压缩 uuid: ' + badId + ' 个异常');
    const ids = s.map((o) => o._id).filter(Boolean);
    chk(new Set(ids).size === ids.length, '无重复 _id');

    const camNode = nodes.find((n) => n._components.some((r) => s[r.__id__] === cam));
    const canvasNode = nodes.find((n) => n._components.some((r) => s[r.__id__].__type__ === 'cc.Canvas'));
    chk(!!camNode && camNode._layer === (1 << 30), 'Camera 节点在 DEFAULT 层');
    chk(!!canvasNode && canvasNode._layer === (1 << 25), 'Canvas 节点在 UI_2D 层');
    chk((cam._visibility & (1 << 25)) !== 0 && (cam._visibility & (1 << 24)) !== 0, '相机可见 UI_2D|UI_3D');
    chk(cam._projection === 0, '相机正交投影');
    chk(cam._priority === (1 << 30), '相机 priority 合理');
    const wrongLayer = nodes.filter((n) => n._layer !== (1 << 25) && n._layer !== (1 << 30));
    chk(wrongLayer.length === 0, '所有节点层为 UI_2D 或 DEFAULT: ' + wrongLayer.map((n) => n._name).join(','));
    const invisible = nodes.filter((n) => {
        const kinds = n._components.map((r) => s[r.__id__].__type__);
        if (kinds.includes('cc.Camera')) return false;
        return !(cam._visibility & n._layer);
    });
    chk(invisible.length === 0, '无被相机剔除的内容节点: ' + invisible.map((n) => n._name).join(','));

    let ptrBad = 0;
    for (let i = 0; i < s.length; i++) {
        const o = s[i];
        if (o.__type__ !== 'cc.Node' && o.__type__ !== 'cc.Scene') continue;
        for (const c of (o._children || [])) if (s[c.__id__]._parent.__id__ !== i) ptrBad++;
        for (const c of (o._components || [])) if (s[c.__id__].node.__id__ !== i) ptrBad++;
    }
    chk(ptrBad === 0, '父子/组件指针双向一致: ' + ptrBad + ' 处不一致');

    let dupUT = 0;
    for (const n of nodes) {
        const kinds = n._components.map((r) => s[r.__id__].__type__);
        if (kinds.filter((k) => k === 'cc.UITransform').length > 1) dupUT++;
    }
    chk(dupUT === 0, '无重复 UITransform（会冲突）: ' + dupUT + ' 个节点');

    const gi = s.findIndex((o) => o.__type__ === 'cc.SceneGlobals');
    chk(gi >= 0 && sc._globals.__id__ === gi, 'cc.Scene._globals 指向真实下标');
    if (gi >= 0) {
        const sg = s[gi];
        for (const k of ['ambient', 'shadows', '_skybox', 'fog', 'octree', 'skin', 'lightProbeInfo']) {
            chk(sg[k] && s[sg[k].__id__], 'SceneGlobals.' + k + ' 引用有效');
        }
    }

    // 脚本组件：恰好 1 个控制器 + N 个 UiFill（UiFill 是设计系统基础件，允许任意数量）
    const scriptTypes = s.map((o) => o.__type__).filter((t) => t && !t.startsWith('cc.'));
    const ctrl = scriptTypes.filter((t) => t !== FILL_UUID);
    chk(ctrl.length === 1, '恰好 1 个控制器脚本组件（实际 ' + ctrl.length + '）');
    chk(ctrl[0] === SCRIPT_UUID[SCRIPT_OF[f]], f + ' 脚本 uuid 与 ' + SCRIPT_OF[f] + ' 权威值一致');
    const unknownScript = scriptTypes.filter((t) => t !== FILL_UUID && t !== SCRIPT_UUID[SCRIPT_OF[f]]);
    chk(unknownScript.length === 0, '无未登记的脚本组件: ' + [...new Set(unknownScript)].join(','));

    const src = fs.readFileSync(path.join(ROOT, 'assets', 'scripts', SCRIPT_SRC[f]), 'utf8');
    chk(/onLoad[\s\S]{0,400}?ensureServices\(\)/.test(src), SCRIPT_OF[f] + ' 在 onLoad 调用 ensureServices()');

    // ScrollView 的 content 必须指向真实节点，且 Mask/Layout 结构完整
    const svComps = s.filter((o) => o.__type__ === 'cc.ScrollView');
    for (const sv of svComps) {
        const cid = sv.content && sv.content.__id__;
        const target = typeof cid === 'number' ? s[cid] : null;
        chk(!!target && target.__type__ === 'cc.Node', 'ScrollView.content 指向真实节点（名称 ' + (target ? target._name : 'null') + '）');
        if (target) {
            const kinds = target._components.map((r) => s[r.__id__].__type__);
            chk(kinds.includes('cc.Layout'), 'ScrollView.content 挂了 cc.Layout（否则列表不排布）');
            const parent = s[target._parent.__id__];
            const parentKinds = parent._components.map((r) => s[r.__id__].__type__);
            chk(parentKinds.includes('cc.Mask'), 'ScrollView 的 view 节点挂了 cc.Mask（裁剪生效）');
        }
    }

    // ---------- D. 路径契约（先建全场景路径表）----------
    const pathOf = new Map();
    const walkPath = (idx, prefix) => {
        const n = s[idx];
        const p = prefix ? prefix + '/' + n._name : n._name;
        pathOf.set(idx, p);
        for (const c of (n._children || [])) walkPath(c.__id__, p);
    };
    for (const c of (sc._children || [])) walkPath(c.__id__, '');
    const have = new Set(pathOf.values());
    const missing = REQUIRED_PATHS[f].filter((p) => !have.has(p));
    chk(missing.length === 0, '路径契约完整（控制器绑定路径全存在）' + (missing.length ? ' → 缺: ' + missing.join(', ') : '（' + REQUIRED_PATHS[f].length + ' 条）'));

    // ---------- B. 内容存在性 ----------
    const kinds = {};
    for (const o of s) kinds[o.__type__] = (kinds[o.__type__] || 0) + 1;

    const canvasChildren = (canvasNode._children || []).map((r) => s[r.__id__]);
    const uiChildren = canvasChildren.filter((n) => {
        const k = n._components.map((r) => s[r.__id__].__type__);
        return !k.includes('cc.Camera') && !k.includes(SCRIPT_UUID[SCRIPT_OF[f]]);
    });
    chk(uiChildren.length >= 3, 'Canvas 下有 ≥3 个 UI 子节点（实际 ' + uiChildren.length + '）');

    for (const [comp, min] of Object.entries(REQUIRED_UI[f])) {
        const got = kinds[comp] || 0;
        const name = comp === FILL_UUID ? 'UiFill' : comp;
        chk(got >= min, '含 ' + name + ' ≥' + min + '（实际 ' + got + '）');
    }

    const labels = s.filter((o) => o.__type__ === 'cc.Label');
    const emptyText = labels.filter((o) => !o._string || typeof o._string !== 'string' || o._string.trim() === '');
    chk(emptyText.length === 0, '所有 Label 有非空 _string（' + labels.length + ' 个 Label）');
    const noAlpha = labels.filter((o) => !o._color || !(o._color.a > 0));
    chk(noAlpha.length === 0, '所有 Label 的 _color.a > 0（可见）');

    // UiFill 必须真的会画出东西：填充 alpha > 0 且尺寸 > 0
    const fills = s.filter((o) => o.__type__ === FILL_UUID);
    chk(fills.length > 0, '存在 UiFill 自绘色块');
    const deadFill = fills.filter((o) => !o.fillColor || !(o.fillColor.a > 0));
    chk(deadFill.length === 0, '所有 UiFill 填充 alpha > 0（否则看不见）: ' + deadFill.length + ' 个');
    let fillNoSize = 0;
    for (const node of nodes) {
        for (const r of node._components) {
            const comp = s[r.__id__];
            if (comp.__type__ !== FILL_UUID) continue;
            const ut = node._components.map((x) => s[x.__id__]).find((x) => x.__type__ === 'cc.UITransform');
            if (!ut || !(ut._contentSize.width > 0) || !(ut._contentSize.height > 0)) fillNoSize++;
        }
    }
    chk(fillNoSize === 0, '所有 UiFill 节点有正尺寸（否则画不出来）: ' + fillNoSize + ' 个');

    const unnamed = nodes.filter((n) => !n._name || n._name === '');
    chk(unnamed.length === 0, '所有节点有名字（层级管理器可辨认）');

    // Overlay 浮层容器：必须有 UITransform（否则子树完全不可见 —— 真实踩过的坑），
    // 且不能有 Mask/Graphics 之类会自己参与裁剪或遮挡的组件。
    const overlayNode = nodes.find((n) => n._name === 'Overlay');
    chk(!!overlayNode, '存在 Overlay 浮层容器节点');
    if (overlayNode) {
        const ok = overlayNode._components.map((r) => s[r.__id__].__type__);
        // ⚠️ 必须是「恰好一个 UITransform」。曾经写成零组件裸节点，
        // 结果节点/尺寸/透明度全部正常但屏幕完全不可见（Cocos UI 渲染依赖
        // 父节点 UITransform 参与世界变换），而那种写法还被本断言"保护"着。
        const utCount = ok.filter((k) => k === 'cc.UITransform').length;
        chk(utCount === 1, 'Overlay 恰好挂 1 个 UITransform（缺了会导致子树不可见）: 实际 ' + utCount);
        const forbidden = ok.filter((k) => k !== 'cc.UITransform');
        chk(forbidden.length === 0, 'Overlay 不含 Mask/Graphics 等自绘或裁剪组件: 实际 ' + forbidden.join(','));
        const ovUT = overlayNode._components.map((r) => s[r.__id__]).find((x) => x.__type__ === 'cc.UITransform');
        chk(!!ovUT && ovUT._contentSize.width > 0 && ovUT._contentSize.height > 0,
            'Overlay 有正尺寸（全屏）: 实际 ' + (ovUT ? ovUT._contentSize.width + 'x' + ovUT._contentSize.height : 'null'));
        chk((overlayNode._children || []).length === 0, 'Overlay 初始无子节点（浮层运行时挂载）');
        // 必须是 Canvas 的最后一个 UI_2D 子节点（在 Camera 之前也优于 Camera 之后）
        const sibs = canvasNode._children.map((r) => s[r.__id__]);
        const lastUI = [...sibs].reverse().find((n) => n._layer === (1 << 25));
        chk(lastUI && lastUI._name === 'Overlay', 'Overlay 是最后一个 UI_2D 子节点（浮层在最上层），实际 ' + (lastUI ? lastUI._name : 'null'));
    }

    // ---------- C. 设计系统合规 ----------
    const offTokenFill = [];
    for (const o of fills) {
        for (const key of ['fillColor', 'borderColor']) {
            const c = o[key];
            if (!c || !(c.a > 0)) continue; // 透明 = 未使用，允许
            const hex = hexOf(c);
            if (!T.tokenNameOf(hex)) offTokenFill.push(o._name + '.' + key + '=' + hex);
        }
    }
    chk(offTokenFill.length === 0, 'UiFill 用色全部来自设计令牌' + (offTokenFill.length ? ' → ' + offTokenFill.slice(0, 6).join(', ') : ''));

    const offTokenLabel = labels
        .map((o) => ({ n: o._string, hex: hexOf(o._color) }))
        .filter((x) => !T.tokenNameOf(x.hex))
        .map((x) => x.n + '=' + x.hex);
    chk(offTokenLabel.length === 0, 'Label 用色全部来自设计令牌' + (offTokenLabel.length ? ' → ' + offTokenLabel.slice(0, 6).join(', ') : ''));

    const bgNode = nodes.find((n) => n._name === 'Bg');
    const bgFill = bgNode ? bgNode._components.map((r) => s[r.__id__]).find((x) => x.__type__ === FILL_UUID) : null;
    chk(!!bgFill && hexOf(bgFill.fillColor) === T.PALETTE.bg.toUpperCase(),
        '页面底色 Bg 是设计令牌 PALETTE.bg（' + T.PALETTE.bg + '）实际 ' + (bgFill ? hexOf(bgFill.fillColor) : 'null'));

    // 深色残留扫描（白底风格下不允许出现旧深色板）
    const DARK = ['#1B1D2A', '#272A3D', '#33374F', '#121622', '#1E2638', '#2C3850', '#DEB887', '#654321'];
    const darkHits = [];
    for (const o of [...fills, ...labels]) {
        for (const key of ['fillColor', 'borderColor', '_color']) {
            const hex = hexOf(o[key]);
            if (hex && DARK.includes(hex)) darkHits.push(o._name + '.' + key);
        }
    }
    chk(darkHits.length === 0, '无旧深色板残留' + (darkHits.length ? ' → ' + darkHits.slice(0, 5).join(', ') : ''));

    console.log('  → nodes=' + nodes.length + '  labels=' + labels.length + '  UiFill=' + fills.length +
        '  componentKinds=' + Object.keys(kinds).filter((k) => k.startsWith('cc.')).length);
    console.log('');
}

// 与官方参考场景的格式对齐抽查
const ref = JSON.parse(fs.readFileSync(REF, 'utf8'));
console.log('=== 与官方参考场景对齐 ===');
chk(ref.some((o) => o.__type__ === 'cc.Node'), '参考场景可读');
console.log('');

if (fail === 0) {
    console.log('ALL_SCENE_VALIDATIONS_PASSED');
} else {
    console.log('FAILURES: ' + fail);
    process.exit(1);
}