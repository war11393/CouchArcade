/**
 * fix-scenes.js — 修复手写 .scene 的三个致命缺陷
 *
 * 依据：编辑器自带参考场景
 *   <Creator>/resources/resources/3d/engine/editor/assets/default_file_content/scene/scene-2d.scene
 *
 * 修复项：
 *  1. _id 格式：36 位带横线 UUID → 22 位 Cocos 压缩 UUID（base64，编辑器场景视图要求）
 *     Scene 的 _id 保留 36 位格式（= 场景资源 uuid，官方参考场景即如此）
 *  2. Camera 节点 _layer：33554432(UI_2D) → 1073741824(DEFAULT)，与官方一致
 *  3. cc.Camera._visibility 覆盖 UI_2D|UI_3D；Camera 节点若为 UI_2D 会被前向剔除
 *
 * 幂等：重复运行结果一致（压缩 UUID 由旧值哈希派生且做格式校验）。
 */
const fs = require('fs');
const path = require('path');

const SCENE_DIR = path.resolve(__dirname, '..', 'assets', 'scenes');
const FILES = ['Loading.scene', 'Lobby.scene', 'Room.scene', 'Game.scene'];

const LAYER_DEFAULT = 1 << 30; // 1073741824
const LAYER_UI_2D = 1 << 25;   // 33554432
const LAYER_UI_3D = 1 << 24;   // 16777216
const CAM_VISIBILITY = LAYER_UI_2D | LAYER_UI_3D; // 41943040

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 由任意字符串稳定派生 22 位压缩 UUID（前 2 位压缩长度头 + 20 位数据） */
function compressedUuid(seed) {
  // 长度头：Cocos 压缩 uuid 前两位为 base64 编码的字节长度
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  const rnd = (i) => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h + i * 2654435761) >>> 0;
  };
  // 16 字节 payload = 20 个 base64 字符
  let out = '';
  for (let i = 0; i < 20; i++) out += B64[rnd(i) % 64];
  return B64[4] + B64[0] + out; // 0x10 = 16 字节 → "E" + "A" 头（22 位总长）
}

const isCompressed = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{22}$/.test(s);
const isLongUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

let grand = { nodes: 0, comps: 0, cams: 0, scenes: 0 };

for (const file of FILES) {
  const p = path.join(SCENE_DIR, file);
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  const stats = { nodesFixed: 0, compsFixed: 0, camRelayer: 0, visFixed: 0 };

  for (const o of arr) {
    if (o.__type__ === 'cc.Scene') {
      // 场景 _id 必须是场景资源 uuid（36 位），保持不动
      if (!isLongUuid(o._id)) throw new Error(file + ': cc.Scene._id 不是 36 位 uuid: ' + o._id);
      continue;
    }
    if (o.__type__ === 'cc.Node') {
      if (isLongUuid(o._id)) {
        o._id = compressedUuid(file + '|node|' + o._name);
        stats.nodesFixed++;
      } else if (!isCompressed(o._id)) {
        throw new Error(file + ': 未知 _id 格式 ' + JSON.stringify(o._id));
      }
      // Camera 节点归位到 DEFAULT 层
      const isCamNode = (o._components || []).some((r) => arr[r.__id__] && arr[r.__id__].__type__ === 'cc.Camera');
      if (isCamNode && o._layer === LAYER_UI_2D) {
        o._layer = LAYER_DEFAULT;
        stats.camRelayer++;
      }
      continue;
    }
    // 属性/内建组件：_id 也应为压缩格式
    if ('node' in o || '__prefab' in o) {
      if (isLongUuid(o._id)) {
        o._id = compressedUuid(file + '|comp|' + o.__type__ + '|' + (o.node ? o.node.__id__ : 'x'));
        stats.compsFixed++;
      }
    }
    if (o.__type__ === 'cc.Camera') {
      if (o._visibility !== CAM_VISIBILITY) {
        o._visibility = CAM_VISIBILITY;
        stats.visFixed++;
      }
    }
  }

  // 校验：所有「承载内容的节点」必须在其相机 _visibility 内。
  // 注意：相机自身节点（通常在 DEFAULT 层）不参与渲染，无需自见。
  const cam = arr.find((o) => o.__type__ === 'cc.Camera');
  void cam;
  for (const n of arr.filter((o) => o.__type__ === 'cc.Node')) {
    const kinds = (n._components || []).map((r) => arr[r.__id__].__type__);
    if (kinds.includes('cc.Camera')) continue; // 相机节点自身跳过
    if (!(kinds.includes('cc.Canvas') || kinds.length === 0 || kinds.some((k) => !k.startsWith('cc.')))) continue;
    if (!(cam._visibility & n._layer)) {
      throw new Error(file + ': 节点 ' + n._name + ' layer=' + n._layer + ' 不在相机可见性内');
    }
  }
  // 校验：Canvas / 自定义脚本节点必须为 UI_2D 层且可见
  for (const n of arr.filter((o) => o.__type__ === 'cc.Node')) {
    const kinds = (n._components || []).map((r) => arr[r.__id__].__type__);
    const isContent = kinds.some((k) => k === 'cc.Canvas' || !k.startsWith('cc.'));
    if (!isContent) continue;
    if (n._layer !== LAYER_UI_2D) {
      throw new Error(file + ': 内容节点 ' + n._name + ' 应在 UI_2D 层，实际 ' + n._layer);
    }
  }
  // 校验所有 _id 唯一
  const ids = arr.map((o) => o._id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error(file + ': _id 有重复');

  fs.writeFileSync(p, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  console.log(file + ': nodes=' + stats.nodesFixed + ' comps=' + stats.compsFixed +
    ' camRelayer=' + stats.camRelayer + ' vis=' + stats.visFixed);
  grand.nodes += stats.nodesFixed; grand.comps += stats.compsFixed;
  grand.cams += stats.camRelayer; grand.visFixed += stats.visFixed;
}
console.log('TOTAL', JSON.stringify(grand));
console.log('SCENE_FIX_OK');
