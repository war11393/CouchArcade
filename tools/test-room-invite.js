/**
 * test-room-invite.js —— 「邀请好友直进房间」全链路契约测试
 *
 * ── 为什么需要这一层 ──
 * 邀请是**跨端 + 跨进程**的功能：A 分享卡片 → B 点开 → B 落到房间页入座
 * → 房主开局 → B 收到 PLAYING 快照进对局。链路上一共有 6 个环节，任一环节
 * 断了都表现为「好友点了没反应」，且**不会有任何报错**（wx 分享 API 全部
 * 静默失败）。这类静默断链只能用静态契约测试钉住。
 *
 * ── 断言策略 ──
 * 按「链路环节」断言代码存在性与一致性，不写死行号/计数。
 * 每类断言都配反例自证（故意破坏后必须变红），避免「符号存在」假通过。
 *
 * 运行：node tools/test-room-invite.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));

const ROOM_SCENE = read('assets/scripts/room/RoomScene.ts');
const SHARE_WX = read('assets/scripts/core/services/wx/WxShareService.ts');
const SHARE_MOCK = read('assets/scripts/core/services/mock/MockShareService.ts');
const SERVICES = read('assets/scripts/core/services/IServices.ts');
const UI_TREES = read('tools/ui-trees.js');
const APP_HOOKS = read('assets/scripts/core/AppHooks.ts');
const LOADING = read('assets/scripts/lobby/LoadingScene.ts');
const ROOM_SCENE_JSON = read('assets/scenes/Room.scene');

// =====================================================================
console.log('\n环节 1：分享内容必须带 roomId + gameId（否则好友点开进不了房）');
// =====================================================================
{
    const m = SHARE_WX.match(/_buildQuery\(info: ShareRoomInfo\): string \{([\s\S]*?)\n    \}/);
    assert(!!m, 'WxShareService._buildQuery 存在');
    const body = m ? m[1] : '';
    assert(/roomId=/.test(body), 'query 含 roomId=');
    assert(/gameId=/.test(body), 'query 含 gameId=');
    assert(/encodeURIComponent/.test(body), 'query 值做了 encodeURIComponent（防注入/截断）');
}

// =====================================================================
console.log('\n环节 2：接收侧能解析 query（冷启动 + 热启动两条路）');
// =====================================================================
{
    assert(/export function parseRoomLaunchQuery/.test(APP_HOOKS), 'AppHooks 导出 parseRoomLaunchQuery');
    assert(/parseRoomLaunchQuery\(launch\.query\)/.test(LOADING)
        || /parseRoomLaunchQuery\([\s\S]{0,40}query\)/.test(LOADING),
        'LoadingScene 冷启动读 launch.query');
    assert(/parseRoomLaunchQuery\(options\.query\)/.test(APP_HOOKS), 'AppHooks 热启动读 options.query');
    // 热启动必须存在：wx.getLaunchOptionsSync 只在冷启动反映参数
    assert(/function handleHotStart/.test(APP_HOOKS), 'handleHotStart 存在（后台点新卡片）');
    assert(/subscribeShow\(handleHotStart\)/.test(APP_HOOKS), 'onShow 已注册 handleHotStart');
    // 解析后必须带 joinRoomId 进房间页（而不是普通建房）
    assert(/joinRoomId: target\.roomId/.test(LOADING), '冷启动传 joinRoomId');
    assert(/joinRoomId: target\.roomId/.test(APP_HOOKS), '热启动传 joinRoomId');
    assert(/joinRoomId: roomId/.test(read('assets/scripts/lobby/LobbyScene.ts')), '大厅手动输房号也走 joinRoomId');
}

// =====================================================================
console.log('\n环节 3：RoomScene 用 joinRoomId 真去入座（而非建房）');
// =====================================================================
{
    assert(/if \(params\.joinRoomId\) \{/.test(ROOM_SCENE), '有 joinRoomId 分支');
    const m = ROOM_SCENE.match(/if \(params\.joinRoomId\) \{([\s\S]*?)\} else \{/);
    assert(!!m && /room\.joinRoom\(params\.joinRoomId\)/.test(m[1]),
        'joinRoomId 分支调用 room.joinRoom（不是 createRoom）');
    assert(/state = await room\.createRoom\(/.test(ROOM_SCENE), 'else 分支才建房');
}

// =====================================================================
console.log('\n环节 4：邀请入口（按钮 + 分享调用 + 显隐条件）');
// =====================================================================
{
    assert(/BtnInvite/.test(ROOM_SCENE), 'RoomScene 引用 BtnInvite');
    assert(/bindClick\(this\.node, 'Canvas\/BtnBar\/BtnInvite'/.test(ROOM_SCENE), 'BtnInvite 绑定了点击');
    assert(/private _onInvite\(\): void/.test(ROOM_SCENE), '_onInvite 方法存在');
    assert(/services\.share\.shareRoom\(/.test(ROOM_SCENE), '_onInvite 调用 shareRoom');
    assert(/private _layoutBtnBar\(\): void/.test(ROOM_SCENE), '_layoutBtnBar 存在（隐藏按钮不留空洞）');

    // 显隐条件：练习房不显示 + 房主才显示 + 只在未开局显示
    const m = ROOM_SCENE.match(/const canInvite =([\s\S]*?);/);
    assert(!!m, 'canInvite 条件存在');
    const cond = m ? m[1] : '';
    assert(/!state\.isPractice/.test(cond), 'canInvite 排除练习房（AI 房邀请无意义）');
    assert(/this\._isOwner/.test(cond), 'canInvite 要求房主（防「双房主」误解）');
    assert(/RoomStatus\.WAITING/.test(cond) && /RoomStatus\.READY/.test(cond),
        'canInvite 只在 WAITING/READY（已开局的卡片是坏链接）');
}

// =====================================================================
console.log('\n环节 5：场景里真的有 BtnInvite 节点（代码绑了但场景没有 = 静默失效）');
// =====================================================================
{
    assert(/buttonNode\('BtnInvite'/.test(UI_TREES), 'ui-trees.js 生成 BtnInvite');
    assert(/BtnInvite/.test(ROOM_SCENE_JSON), 'Room.scene 里已落地 BtnInvite 节点');
    assert(/BtnInviteLabel/.test(ROOM_SCENE_JSON), 'BtnInvite 带 Label 子节点');
    // 三个按钮都要在场景里
    for (const b of ['BtnReady', 'BtnInvite', 'BtnLeave']) {
        assert(ROOM_SCENE_JSON.includes(b), `Room.scene 含 ${b}`);
    }
    // 宽度必须一致（否则 _layoutBtnBar 的等距排位会撞在一起）
    const widths = [...UI_TREES.matchAll(/buttonNode\('(BtnReady|BtnInvite|BtnLeave)', '[^']*', (\d+), (\d+)/g)]
        .map((m) => Number(m[2]));
    assert(widths.length === 3, `解析到 3 个 BtnBar 按钮宽度（实际 ${widths.length}）`);
    assert(new Set(widths).size === 1, `三个按钮宽度一致（实际 ${widths.join('/')}）`);
}

// =====================================================================
console.log('\n环节 6：非房主也要能进对局（PLAYING 推送是唯一入口）');
// =====================================================================
{
    const m = ROOM_SCENE.match(/case RoomStatus\.PLAYING:([\s\S]*?)break;/);
    assert(!!m, '存在 PLAYING 分支');
    assert(m ? /this\._enterGame\(state\)/.test(m[1]) : false,
        'PLAYING 分支调用 _enterGame（否则被邀请方永远卡在房间页）');
    assert(/_entered/.test(ROOM_SCENE), '_enterGame 有 _entered 幂等闸（防房主重复切入）');
    // 幂等闸必须在最前面
    const em = ROOM_SCENE.match(/_enterGame\(state: RoomState\): void \{([\s\S]{0,200})/);
    assert(em ? /if \(this\._entered\)\s*\{?\s*return/.test(em[1]) : false,
        '_enterGame 开头就是 _entered 短路');
}

// =====================================================================
console.log('\n环节 7：退房清理（防止分享出已失效的房间卡片）');
// =====================================================================
{
    assert(/clearPassiveShare\(\): void;/.test(SERVICES), 'IShareService 声明 clearPassiveShare');
    assert(/public clearPassiveShare\(\): void/.test(SHARE_WX), 'WxShareService 实现 clearPassiveShare');
    assert(/public clearPassiveShare\(\): void/.test(SHARE_MOCK), 'MockShareService 实现 clearPassiveShare（接口不能只改一半）');
    assert(/services\.share\.clearPassiveShare\(\)/.test(ROOM_SCENE), '退房时调用 clearPassiveShare');
    // 退房清理不能把退房本身搞挂
    const lm = ROOM_SCENE.match(/private async _onLeave\(\): Promise<void> \{([\s\S]*?)await services\.room\.leaveRoom\(\)/);
    assert(lm ? /try \{/.test(lm[1]) : false, '清理包在 try 里（失败不阻塞退房）');
}

// =====================================================================
console.log('\n环节 8：分享标题动态化（能反映真实入座人数）');
// =====================================================================
{
    assert(/title\?: string;/.test(SERVICES), 'ShareRoomInfo.title 可选字段存在');
    assert(/roomInfo\.title \|\|/.test(SHARE_WX), 'shareRoom 优先用自定义 title');
    assert(/info\.title \|\|/.test(SHARE_WX), '被动转发也用自定义 title');
    assert(/private _lastState: RoomState \| null/.test(ROOM_SCENE), 'RoomScene 记录最新快照');
    assert(/this\._lastState = state;/.test(ROOM_SCENE), '_onRoomState 每次更新 _lastState');
}

// =====================================================================
console.log('\n反例自证：故意破坏后断言必须变红');
// =====================================================================
{
    const q = (src) => {
        const m = src.match(/_buildQuery\(info: ShareRoomInfo\): string \{([\s\S]*?)\n    \}/);
        return m ? m[1] : '';
    };
    // 反例 A：删掉 `&gameId=...` 整段（字面量 + 插值都在引号内）
    const broken1 = SHARE_WX.replace(/&gameId=\$\{encodeURIComponent\(String\(info\.gameId\)\)\}/, '');
    assert(!/gameId=/.test(q(broken1)), '反例 A：删掉 gameId 后 query 里确实没有它（断言有效）');
    assert(/roomId=/.test(q(broken1)), '反例 A 对照组：roomId 仍在（不是「什么都查不到」）');

    // 反例 B：把 PLAYING 分支的 _enterGame 去掉 → 环节 6 必须红
    // ⚠️ 用「定位分支范围再剔除该调用」的方式，别用跨行 backreference ——
    //    上个版本正则没匹配上，导致反例恒真（假通过）。
    const plStart = ROOM_SCENE.indexOf('case RoomStatus.PLAYING:');
    const plEnd = ROOM_SCENE.indexOf('break;', plStart);
    assert(plStart > 0 && plEnd > plStart, '反例 B 前置：能定位 PLAYING 分支范围');
    const broken2 =
        ROOM_SCENE.slice(0, plStart) +
        ROOM_SCENE.slice(plStart, plEnd).replace(/this\._enterGame\(state\);/, '') +
        ROOM_SCENE.slice(plEnd);
    const bm = broken2.match(/case RoomStatus\.PLAYING:([\s\S]*?)break;/);
    assert(bm ? !/this\._enterGame\(state\);/.test(bm[1]) : false,
        '反例 B：拆掉 PLAYING → _enterGame() 调用后确实查不到（断言有效）');
    // 对照组：同一文件里 PLAYING 之外的 _enterGame 仍在（说明只改了目标那处）
    assert((broken2.match(/_enterGame\(state\)/g) || []).length
        < (ROOM_SCENE.match(/_enterGame\(state\)/g) || []).length,
        '反例 B 对照组：_enterGame 调用数确实减少（不是「本就查不到」）');

    // 把 BtnInvite 从场景树拿掉 → 环节 5 必须红
    const broken3 = UI_TREES.replace(/buttonNode\('BtnInvite'[\s\S]*?\}\),\n/, '');
    assert(!/buttonNode\('BtnInvite'/.test(broken3), '反例 C：从场景树删掉 BtnInvite 后确实查不到（断言有效）');
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
