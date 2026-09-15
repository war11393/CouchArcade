/**
 * gen-scenes.js —— 生成 4 个 .scene，**包含完整静态 UI 节点树**。
 *
 * 与旧版的根本区别：旧版只生成 Canvas + SceneRoot + Camera 三个空节点，
 * UI 全靠脚本运行时 addChild 现造；那些节点不写回 .scene，
 * 所以编辑器层级管理器里看不到任何 Label / ProgressBar / ScrollView。
 * 现在 UI 作为静态节点写进 .scene。
 *
 * Scene 结构：
 *   Scene
 *    └─ Canvas                [cc.Canvas, cc.UITransform, cc.Widget]
 *        ├─ <UI 节点树…>       [cc.Label / cc.Graphics / cc.ProgressBar / cc.ScrollView …]
 *        ├─ SceneRoot         [<控制器脚本>]   ← UI 逻辑挂这里
 *        └─ Camera            [cc.Camera]
 *
 * 所有格式约束见 scene-builder.js 顶部注释。
 */
const fs = require('fs');
const path = require('path');
const B = require('./scene-builder.js');
const { loadingTree, lobbyTree, roomTree, gameTree } = require('./ui-trees.js');

const ROOT = path.resolve(__dirname, '..');
const SCENE_DIR = path.join(ROOT, 'assets', 'scenes');

const { LAYER_DEFAULT, LAYER_UI_2D, makeNode, widget, uiTransform, stableUuid, compressedUuid, v3 } = B;

const DESIGN_W = 720;
const DESIGN_H = 1280;

/** @ccclass 名 -> 脚本压缩 uuid（由 extract-script-uuids.js 提取的权威值） */
const SCRIPT_UUID = JSON.parse(fs.readFileSync(path.join(__dirname, 'script-uuids.json'), 'utf8'));

const SCENES = [
    { file: 'Loading', script: 'LoadingScene', tree: loadingTree },
    { file: 'Lobby', script: 'LobbyScene', tree: lobbyTree },
    { file: 'Room', script: 'RoomScene', tree: roomTree },
    { file: 'Game', script: 'GameScene', tree: gameTree },
];

/** Canvas 节点（含 cc.Canvas / UITransform / Widget，Camera 由 builder 挂） */
function canvasNode() {
    // 注意：size 传 null 以免 makeNode 自动加一个 UITransform（会与显式传入的重复）
    const n = makeNode('Canvas', {
        pos: [DESIGN_W / 2, DESIGN_H / 2],
        size: null,
        layer: LAYER_UI_2D,
    }, [
        { type: 'cc.Canvas', body: { _alignCanvasWithScreen: true } },
        uiTransform(DESIGN_W, DESIGN_H),
        widget({ alignFlags: 45 }),
    ]);
    return n;
}

/** SceneRoot：UI 逻辑脚本挂载点 */
function sceneRootNode() {
    return makeNode('SceneRoot', { pos: [0, 0], size: [0, 0], layer: LAYER_UI_2D }, []);
}

/** Camera 节点（builder 会补 cc.Camera 组件） */
function cameraNode() {
    return makeNode('Camera', {
        pos: [0, 0, 1000], size: null, layer: LAYER_DEFAULT,
    }, []);
}

/**
 * 编译一个场景。
 *
 * 注意：UI 节点树里所有节点的坐标都是相对 Canvas 中心的，
 * Canvas 自身在场景里的位置是 (设计宽/2, 设计高/2) —— 与官方 2D 场景一致。
 */
function buildScene(file, scriptName, treeFn) {
    const canvas = canvasNode();
    const rootNode = sceneRootNode();
    const cam = cameraNode();

    // Canvas 的子节点顺序：UI 树 → SceneRoot → Overlay → Camera
    //
    // ⚠️ Overlay 必须排在 SceneRoot 之后：它是 Toast/弹窗的父节点，
    // 只有排在所有 UI_2D 节点最后，浮层才真正盖在大厅列表/棋盘之上。
    // （见 tools/ui-trees.js 的 overlayNode 注释：挂 Canvas 会被 Mask 裁掉）
    const uiNodes = treeFn();
    const overlayIdx = uiNodes.findIndex((n) => n.name === 'Overlay');
    const overlay = overlayIdx >= 0 ? uiNodes.splice(overlayIdx, 1)[0] : null;
    canvas.children = overlay
        ? [...uiNodes, rootNode, overlay, cam]
        : [...uiNodes, rootNode, cam];

    const { arr, idx } = B.compile(file, SCRIPT_UUID[scriptName], [canvas], (roots, map) => rootNode);

    // 自检：所有 __id__ 必须落在数组范围内，且类型可解析
    const oob = [];
    const bad = [];
    const notNumber = [];
    const scan = (v, p) => {
        if (Array.isArray(v)) return v.forEach((x, i) => scan(x, p + '[' + i + ']'));
        if (v && typeof v === 'object') {
            if ('__id__' in v) {
                const id = v.__id__;
                if (typeof id !== 'number') {
                    // 曾出现过：把整棵节点描述写进 __id__（ScrollView.content），静默生成垃圾数据
                    notNumber.push(p + ' -> ' + (typeof id === 'object' ? JSON.stringify(id).slice(0, 40) : String(id)));
                } else {
                    const target = arr[id];
                    if (!target) oob.push(p + ' -> ' + id);
                    else if (target.__pending__) bad.push(p + ' -> 未实体化的组件下标 ' + id);
                }
            }
            for (const [k, val] of Object.entries(v)) {
                if (k === '__id__' && typeof val === 'number') continue;
                scan(val, p + '.' + k);
            }
        }
    };
    arr.forEach((o, i) => scan(o, '[' + i + ']' + (o.__type__ || '?')));
    if (notNumber.length) throw new Error(file + ': __id__ 不是数字（引用写法错了）→ ' + notNumber.slice(0, 8).join(', '));
    if (oob.length) throw new Error(file + ': 越界 __id__ → ' + oob.slice(0, 8).join(', '));
    if (bad.length) throw new Error(file + ': 引用了未实体化的组件 → ' + bad.slice(0, 8).join(', '));

    // 自检：_parent / _children / _components 双向一致
    for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (o.__type__ !== 'cc.Node' && o.__type__ !== 'cc.Scene') continue;
        for (const c of (o._children || [])) {
            const child = arr[c.__id__];
            if (!child || (child.__type__ !== 'cc.Node')) throw new Error(file + ': _children 指向非节点');
            if (child._parent.__id__ !== i) throw new Error(file + ': ' + o._name + '/' + child._name + ' 父子指针不一致');
        }
        for (const c of (o._components || [])) {
            const comp = arr[c.__id__];
            if (!comp || !comp.__type__) throw new Error(file + ': _components 指向无效对象');
            if (comp.node.__id__ !== i) throw new Error(file + ': 组件 ' + comp.__type__ + ' node 指针不一致');
        }
    }
    return arr;
}

function countUI(arr) {
    const c = {};
    for (const o of arr) {
        if (o.__type__ && !o.__type__.startsWith('cc.') && o.__type__.length === 23) continue; // 脚本 uuid
        c[o.__type__] = (c[o.__type__] || 0) + 1;
    }
    return c;
}

function main() {
    if (!fs.existsSync(SCENE_DIR)) fs.mkdirSync(SCENE_DIR, { recursive: true });

    for (const s of SCENES) {
        const arr = buildScene(s.file, s.script, s.tree);
        fs.writeFileSync(
            path.join(SCENE_DIR, s.file + '.scene'),
            JSON.stringify(arr, null, 2) + '\n',
            'utf8',
        );
        fs.writeFileSync(
            path.join(SCENE_DIR, s.file + '.scene.meta'),
            JSON.stringify({
                ver: '1.1.50', importer: 'scene', imported: true,
                uuid: stableUuid(s.file, 'scenemeta'),
                files: ['.json'], subMetas: {}, userData: {},
            }, null, 2),
            'utf8',
        );
        const nodeCount = arr.filter((o) => o.__type__ === 'cc.Node').length;
        const fillCount = arr.filter((o) => o.__type__ === SCRIPT_UUID.UiFill).length;
        const labelCount = arr.filter((o) => o.__type__ === 'cc.Label').length;
        console.log(
            `generated ${s.file}.scene  nodes=${nodeCount}  labels=${labelCount}  UiFill=${fillCount}  ` +
            `componentKinds=${Object.keys(countUI(arr)).length}`,
        );
    }

    fs.writeFileSync(
        path.join(ROOT, 'assets', 'scenes.meta'),
        JSON.stringify({
            ver: '1.2.0', importer: 'directory', imported: true,
            uuid: stableUuid('scenes', 'dirmeta'),
            files: [], subMetas: {}, userData: {},
        }, null, 2),
        'utf8',
    );
    console.log('generated assets/scenes.meta');
    console.log('done. 请接着运行 node tools/validate-scenes.js 与 node tools/dump-tree.js');
}

main();
