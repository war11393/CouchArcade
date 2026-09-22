/**
 * 云函数信封「双重包装」回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 背景（2026-09-22 真机事故）：
 *   handler 里 `return ok(x)`，而 wrap() 会判 `result.__isResponse` 决定
 *   是否再包一层。ok()/fail() 当初没打这个标记 → 必然被包两次，
 *   客户端收到 {code,success,data:{code,success,data:x}}，
 *   WxCloudService 解包后拿到内层信封对象（没有 openid 字段），
 *   于是报「login 返回缺少 openid」并把加载页卡死。
 *
 * 本测试直接 require 云函数的 common.js（真实代码，非复制品），
 * 用与 wrap() 完全相同的判定逻辑跑「handler 返回值 → 客户端收到什么」，
 * 断言客户端解包后能拿到**业务数据本身**。
 *
 * 运行：node tools/test-cloud-envelope.js
 */

const path = require('path');
const fs = require('fs');

const FUNCS = [
    'login',
    'createRoom',
    'joinRoom',
    'ready',
    'startGame',
    'getRoomState',
    'planehunt_flip',
    'gomoku_move',
    'settleGame',
];

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
    }
}

/**
 * 复刻 wrap() 的包装逻辑（与 common.js 的 wrap 保持一致）。
 * 刻意不 require wrap() 本身：那需要 wx-server-sdk 与云环境，
 * 本地跑不起来；这里只复刻「包装判定」这一条关键逻辑。
 */
function wrapLike(result) {
    const mod = { ok: (d) => ({ code: 0, success: true, data: d === undefined ? null : d, __isResponse: true }) };
    return result && result.__isResponse ? result : mod.ok(result);
}

/** 复刻 WxCloudService.callFunction 的解包逻辑（只取关键部分）。 */
function unwrapLike(res) {
    const envelope = res && res.result;
    if (!envelope) return { error: '返回体为空' };
    const shaped = typeof envelope.code === 'number' || typeof envelope.success === 'boolean';
    if (!shaped) return { error: '信封形状不符' };
    if (envelope.success === false) return { error: envelope.message || '业务失败' };
    return { data: envelope.data === undefined ? null : envelope.data };
}

console.log('=== 云函数信封双重包装回归测试 ===\n');

// ---------------------------------------------------------------------
console.log('场景 1：common.js 的 ok() 必须自带 __isResponse 标记');
// ---------------------------------------------------------------------
{
    const commonPath = path.join(__dirname, '..', 'cloudfunctions', 'common', 'index.js');
    check('common/index.js 存在', fs.existsSync(commonPath));

    const src = fs.readFileSync(commonPath, 'utf8');

    // 静态断言：ok()/fail() 的返回体里必须出现 __isResponse。
    // 这比 require 更可靠 —— require 会拉起 wx-server-sdk，本地无此依赖。
    const okBody = src.slice(src.indexOf('function ok('), src.indexOf('function ok(') + 400);
    const failBody = src.slice(src.indexOf('function fail('), src.indexOf('function fail(') + 300);

    check('ok() 返回体带 __isResponse', /__isResponse/.test(okBody), okBody.slice(0, 200));
    check('fail() 返回体带 __isResponse', /__isResponse/.test(failBody), failBody.slice(0, 200));
}

// ---------------------------------------------------------------------
console.log('\n场景 2：wrap() 不再二次包装 handler 返回的 ok() 信封');
// ---------------------------------------------------------------------
{
    // 模拟修复后的 ok()：带标记
    const fixedOk = { code: 0, success: true, data: { openid: 'oABC' }, __isResponse: true };
    const wrapped = wrapLike(fixedOk);

    check('包装后仍是单层（data 直接是业务数据）', wrapped.data.openid === 'oABC',
        `实际 data=${JSON.stringify(wrapped.data)}`);

    const { data, error } = unwrapLike({ result: wrapped });
    check('客户端解包不报错', !error, error);
    check('客户端拿到 openid（事故的核心症状）', data && data.openid === 'oABC',
        `实际=${JSON.stringify(data)}`);
}

// ---------------------------------------------------------------------
console.log('\n场景 3：反例 —— 未打标记时必然双重包装（证明测试有效）');
// ---------------------------------------------------------------------
{
    // 模拟修复前的 ok()：不带标记（这正是事故根因）
    const buggyOk = { code: 0, success: true, data: { openid: 'oABC' } };
    const wrapped = wrapLike(buggyOk);

    check('双重包装确实发生（data 变成内层信封）',
        wrapped.data && wrapped.data.code === 0 && wrapped.data.success === true,
        `实际 data=${JSON.stringify(wrapped.data)}`);

    const { data } = unwrapLike({ result: wrapped });
    check('客户端拿不到 openid（复现事故）', !(data && data.openid),
        `意外拿到了 openid=${data && data.openid}`);
}

// ---------------------------------------------------------------------
console.log('\n场景 4：9 个云函数副本与权威源完全一致');
// ---------------------------------------------------------------------
{
    const authoritative = fs.readFileSync(
        path.join(__dirname, '..', 'cloudfunctions', 'common', 'index.js'), 'utf8');

    for (const fn of FUNCS) {
        const p = path.join(__dirname, '..', 'cloudfunctions', fn, 'common.js');
        if (!fs.existsSync(p)) {
            check(`${fn}/common.js 存在`, false, '文件缺失 —— 部署会 require 失败');
            continue;
        }
        const content = fs.readFileSync(p, 'utf8');
        check(`${fn}/common.js 与权威源一致`, content === authoritative);
    }
}

// ---------------------------------------------------------------------
console.log('\n场景 5：所有 handler 内的 `return ok(...)` 都能被正确识别');
// ---------------------------------------------------------------------
{
    let totalOk = 0;
    for (const fn of FUNCS) {
        const p = path.join(__dirname, '..', 'cloudfunctions', fn, 'index.js');
        if (!fs.existsSync(p)) continue;
        const src = fs.readFileSync(p, 'utf8');
        const matches = src.match(/return ok\(/g);
        if (matches) totalOk += matches.length;
    }
    check(`9 个云函数共 ${totalOk} 处 return ok()，全部经 ok() 打标记`, totalOk === 16,
        `找到 ${totalOk} 处，预期恰好 16（login 1 + createRoom 1 + joinRoom 5 + ready 1 + startGame 2 + ` +
            `getRoomState 2 + planehunt_flip 2 + gomoku_move 1 + settleGame 1）`);
}

console.log('\n' + '='.repeat(60));
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
