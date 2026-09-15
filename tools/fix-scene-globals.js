/**
 * fix-scene-globals.js — 修复 __id__ 越界引用
 *
 * 依据：__id__ 是【数组下标】，不是独立引用号。
 *   编辑器官方参考场景 scene-2d.scene 中，cc.SceneGlobals 位于 index 8，
 *   cc.Scene._globals 就写 {"__id__": 8}，各子信息依次 9..14。
 *
 * 我们手写场景把 SceneGlobals 放在 index 10，却写 _globals -> 99，
 * 子信息写成 100..106 —— 全部越界 → 反序列化得到 undefined → 场景加载失败。
 *
 * 修复：把所有指向 SceneGlobals 及其子信息的 __id__ 重写为真实下标。
 */
const fs = require('fs');
const path = require('path');

const SCENE_DIR = path.resolve(__dirname, '..', 'assets', 'scenes');
const FILES = ['Loading.scene', 'Lobby.scene', 'Room.scene', 'Game.scene'];

const GLOBAL_CHILD_TYPES = [
  'cc.AmbientInfo',
  'cc.ShadowsInfo',
  'cc.SkyboxInfo',
  'cc.FogInfo',
  'cc.OctreeInfo',
  'cc.SkinInfo',
  'cc.LightProbeInfo',
];
// SceneGlobals 上的字段名 -> 目标 __type__
const FIELD_TO_TYPE = {
  ambient: 'cc.AmbientInfo',
  shadows: 'cc.ShadowsInfo',
  _skybox: 'cc.SkyboxInfo',
  fog: 'cc.FogInfo',
  octree: 'cc.OctreeInfo',
  skin: 'cc.SkinInfo',
  lightProbeInfo: 'cc.LightProbeInfo',
};

let totalFixed = 0;

for (const file of FILES) {
  const p = path.join(SCENE_DIR, file);
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));

  const idxOfType = (t) => arr.findIndex((o) => o.__type__ === t);
  const gi = idxOfType('cc.SceneGlobals');
  if (gi < 0) throw new Error(file + ': 找不到 cc.SceneGlobals');

  let fixed = 0;
  const setRef = (holder, field, wantType, note) => {
    const before = holder[field] && holder[field].__id__;
    if (before === idxOfType(wantType)) return;
    holder[field] = { __id__: idxOfType(wantType) };
    console.log('  ' + note + '.' + field + ': ' + before + ' -> ' + idxOfType(wantType));
    fixed++;
  };

  // 1) cc.Scene._globals -> SceneGlobals 的真实下标
  const scene = arr.find((o) => o.__type__ === 'cc.Scene');
  setRef(scene, '_globals', 'cc.SceneGlobals', 'cc.Scene');

  // 2) SceneGlobals 的每个子信息引用
  const sg = arr[gi];
  for (const [field, type] of Object.entries(FIELD_TO_TYPE)) {
    if (!(field in sg)) continue;
    setRef(sg, field, type, 'cc.SceneGlobals');
  }

  // 3) 校验：所有 __id__ 都必须在数组范围内，且指向的元素类型正确
  const validators = [
    ['cc.Scene', '_globals', 'cc.SceneGlobals'],
    ['cc.Node', '_parent', null], // null 表示任意（Scene 或 Node）
  ];
  const NODELIKE = new Set(['cc.Node', 'cc.Scene']);
  for (const o of arr) {
    if (o._parent && typeof o._parent.__id__ === 'number') {
      const t = arr[o._parent.__id__] && arr[o._parent.__id__].__type__;
      if (!NODELIKE.has(t)) throw new Error(file + ': 节点 ' + o._name + ' _parent -> ' + t + ' (应为 Node/Scene)');
    }
    if (o._children) {
      for (const c of o._children) {
        if (typeof c.__id__ !== 'number' || !arr[c.__id__]) {
          throw new Error(file + ': ' + o._name + ' _children 越界 ' + c.__id__);
        }
      }
    }
    if (o._components) {
      for (const c of o._components) {
        if (typeof c.__id__ !== 'number' || !arr[c.__id__]) throw new Error(file + ': _components 越界');
      }
    }
    if (o.node && typeof o.node.__id__ === 'number' && !arr[o.node.__id__]) {
      throw new Error(file + ': 组件 ' + o.__type__ + ' 的 node 引用越界');
    }
    if (o._cameraComponent && typeof o._cameraComponent.__id__ === 'number') {
      const t = arr[o._cameraComponent.__id__] && arr[o._cameraComponent.__id__].__type__;
      if (t !== 'cc.Camera') throw new Error(file + ': Canvas._cameraComponent -> ' + t);
    }
  }
  // 全局扫描：任何 __id__ 都不允许越界
  const bad = [];
  const walk = (v, pathStr) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, pathStr + '[' + i + ']'));
    if (v && typeof v === 'object') {
      if (typeof v.__id__ === 'number' && Object.keys(v).length === 1 && !arr[v.__id__]) {
        bad.push(pathStr + ' -> ' + v.__id__);
      }
      for (const [k, val] of Object.entries(v)) {
        if (k === '__id__' && typeof val === 'number') continue;
        walk(val, pathStr + '.' + k);
      }
    }
  };
  arr.forEach((o, i) => walk(o, '[' + i + ']' + o.__type__));
  if (bad.length) throw new Error(file + ': 仍有越界 __id__ 引用:\n  ' + bad.join('\n  '));

  fs.writeFileSync(p, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  console.log(file + ': fixed ' + fixed + ' refs, SceneGlobals at index ' + gi + ', array len ' + arr.length);
  totalFixed += fixed;
}
console.log('TOTAL_FIXED=' + totalFixed);
console.log('GLOBALS_FIX_OK');
