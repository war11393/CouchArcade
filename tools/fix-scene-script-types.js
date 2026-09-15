/**
 * fix-scene-script-types.js
 *
 * 修复：.scene 里脚本组件的 __type__ 必须写【脚本的压缩 uuid】，不能写 @ccclass 名。
 *
 * 症状：编辑器报
 *   Missing class: LobbyScene
 *   Script "LobbyScene" attached to "SceneRoot" is missing or invalid.
 *
 * 原因：反序列化时 Cocos 用 __type__ 字符串去【类注册表】里按 uuid 查类
 *       （ccclass 注册时以脚本压缩 uuid 为键），
 *       而手写场景写的是 ccclass 名 "LobbyScene" → 查不到 → 组件丢失 → 场景不可见。
 *
 * 正确值来自编辑器自己的编译产物（_RF.push 第二个参数），
 * 由 tools/extract-script-uuids.js 提取到 tools/script-uuids.json。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCENE_DIR = path.join(ROOT, 'assets', 'scenes');

const uuidMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'script-uuids.json'), 'utf8'));

// 场景文件 -> 该场景要挂的控制器类
const SCENE_SCRIPT = {
  Loading: 'LoadingScene',
  Lobby: 'LobbyScene',
  Room: 'RoomScene',
  Game: 'GameScene',
};

let total = 0;
for (const [scene, cls] of Object.entries(SCENE_SCRIPT)) {
  const p = path.join(SCENE_DIR, scene + '.scene');
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cid = uuidMap[cls];
  if (!cid) throw new Error('缺少 ' + cls + ' 的压缩 uuid，请先跑 extract-script-uuids.js');

  let n = 0;
  for (const o of arr) {
    if (o.__type__ === cls) {
      o.__type__ = cid;
      n++;
    }
  }
  if (n !== 1) throw new Error(scene + ': 期望恰好 1 个 ' + cls + ' 组件，实际 ' + n);
  fs.writeFileSync(p, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  console.log(scene.padEnd(9) + ' ' + cls.padEnd(14) + ' __type__ -> ' + cid);
  total += n;
}
console.log('TOTAL_FIXED=' + total);
console.log('SCRIPT_TYPE_OK');
