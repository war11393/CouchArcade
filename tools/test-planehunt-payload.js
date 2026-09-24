/**
 * test-planehunt-payload.js —— 寻机头翻格结果「云函数写入字段 ↔ 客户端协议」契约
 *
 * ── 为什么需要这一层 ──
 * 2026-09-24 真机事故：`planehunt_flip` 往 `flips[]` 里只写 `playerId`，
 * 而客户端 `PhFlipResultPayload` 读的是 `byPlayerId`。后果不是「少显示一格」，
 * 而是：
 *   · byPlayerId = undefined → 归属判定失败
 *   · nextPlayerId = undefined → 回合判定恒 false → **玩家无法落子**
 *   · headsFound/score = undefined → HUD 直接显示 "undefined"
 * 这类「字段名不一致」是静默的 —— 没有任何一处会报错，typecheck 也看不见
 * （云函数是 JS）。所以必须有测试把两端**钉在一起**。
 *
 * ── 断言策略 ──
 * 不写死「恰好 N 个字段」（那种断言会在合理新增字段时误报，见
 * test-cloud-envelope 的教训）。这里断言的是**语义**：
 *   ① 客户端协议声明的每个必填字段，云函数写入时都必须提供；
 *   ② 人类那一手与 AI 那一手写入的字段集合必须一致
 *      （客户端对每格都用同一套解析逻辑）；
 *   ③ 存在旧字段名回落逻辑（byPlayerId ← playerId），防止重连重放时崩溃。
 *
 * 运行：node tools/test-planehunt-payload.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions', 'planehunt_flip', 'index.js');
const PROTO = path.join(ROOT, 'assets', 'scripts', 'core', 'protocol', 'Protocol.ts');
const GAME = path.join(ROOT, 'assets', 'scripts', 'games', 'planehunt', 'PlaneHuntGame.ts');

let passed = 0;
let failed = 0;

function ok(msg) {
    passed++;
    console.log(`  ✓ ${msg}`);
}
function bad(msg) {
    failed++;
    console.error(`  ✗ ${msg}`);
}
function assert(cond, msg) {
    if (cond) {
        ok(msg);
    } else {
        bad(msg);
    }
}

// ---------------------------------------------------------------------
console.log('\n场景 1：客户端协议 PhFlipResultPayload 能解析出字段清单');
// ---------------------------------------------------------------------
const protoSrc = fs.readFileSync(PROTO, 'utf8');
const ifaceMatch = protoSrc.match(/export interface PhFlipResultPayload\s*\{([\s\S]*?)\n\}/);
assert(!!ifaceMatch, 'PhFlipResultPayload 接口存在');

/** 解析接口体里声明的字段名（忽略注释与嵌套）。 */
function parseFields(body) {
    const names = [];
    for (const line of body.split('\n')) {
        // 去掉行尾注释后再匹配 `  name: type;`
        const noComment = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
        const m = noComment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/);
        if (m && m[1] !== 'export') {
            names.push(m[1]);
        }
    }
    return names;
}

const declared = ifaceMatch ? parseFields(ifaceMatch[1]) : [];
assert(declared.length >= 8, `解析到 ${declared.length} 个协议字段（期望 ≥8）`);
console.log(`    字段：${declared.join(', ')}`);

// 这几个是「缺了会直接导致 UI 出错/无法落子」的，必须存在
const critical = ['byPlayerId', 'cell', 'row', 'col', 'nextPlayerId', 'headsFound', 'score'];
for (const f of critical) {
    assert(declared.includes(f), `协议含关键字段 ${f}`);
}

// ---------------------------------------------------------------------
console.log('\n场景 2：云函数写入 flips 时提供了全部关键字段');
// ---------------------------------------------------------------------
const cfSrc = fs.readFileSync(CF, 'utf8');

// 人类那一手：从 humanFlipRecord 定义里抽字段
const humanMatch = cfSrc.match(/const humanFlipRecord = \{([\s\S]*?)\n    \};/);
assert(!!humanMatch, '存在 humanFlipRecord（人类那一手的记录，写库与喂 AI 共用）');
const humanFields = humanMatch
    ? [...humanMatch[1].matchAll(/^\s{8}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
    : [];
console.log(`    humanFlipRecord 字段：${humanFields.join(', ')}`);

for (const f of critical) {
    assert(humanFields.includes(f), `人类那一手写入 ${f}`);
}

// AI 那一手：appendFlip 调用里必须有同样的字段
const aiMatch = cfSrc.match(/flips = appendFlip\(flips, \{([\s\S]*?)\n        \}\);/);
assert(!!aiMatch, '存在 AI 那一手的 appendFlip 调用');
const aiFields = aiMatch
    ? [...aiMatch[1].matchAll(/^\s{12}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1])
    : [];
console.log(`    AI 那一手字段：${aiFields.join(', ')}`);

for (const f of critical) {
    assert(aiFields.includes(f), `AI 那一手写入 ${f}`);
}

// ---------------------------------------------------------------------
console.log('\n场景 3：两处写入的字段集合必须一致（客户端只有一套解析逻辑）');
// ---------------------------------------------------------------------
for (const f of humanFields) {
    if (f === 'playerId') {
        continue; // 兼容旧客户端的别名，AI 侧也写了
    }
    assert(aiFields.includes(f), `AI 侧也提供 ${f}（与人类侧一致）`);
}

// ---------------------------------------------------------------------
console.log('\n场景 4：客户端存在旧字段回落（重连重放旧数据不能崩）');
// ---------------------------------------------------------------------
const gameSrc = fs.readFileSync(GAME, 'utf8');
assert(/p\.byPlayerId \|\| (raw\.playerId|\(raw\.playerId)/.test(gameSrc)
    || /p\.byPlayerId \?\? raw\.playerId/.test(gameSrc),
    'byPlayerId 缺失时回落到 playerId');
assert(/p\.nextPlayerId \|\| this\._serverTurnId/.test(gameSrc)
    || /p\.nextPlayerId \?\? this\._serverTurnId/.test(gameSrc),
    'nextPlayerId 缺失时保持当前回合（而不是灌 undefined）');
// 反例：不能出现直接把可能为 undefined 的值赋给回合的地方
assert(!/this\._serverTurnId = p\.nextPlayerId;/.test(gameSrc),
    '回合字段不存在「直接赋值 p.nextPlayerId」（会让回合判定恒 false）');

// ---------------------------------------------------------------------
console.log('\n场景 5：反例自证 —— 故意破坏字段后断言必须变红');
// ---------------------------------------------------------------------
{
    // 抽字段的函数与场景 2 保持一致，确保「断言有效性」被真正验证。
    const fieldsOf = (src) => {
        const m = src.match(/const humanFlipRecord = \{([\s\S]*?)\n    \};/);
        return m ? [...m[1].matchAll(/^\s{8}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]) : [];
    };

    // 反例 A：拿掉 humanFlipRecord 里的 nextPlayerId 行
    const brokenA = cfSrc.replace(
        /^\s{8}nextPlayerId: nextPlayerId,$/m,
        '        /* removed */',
    );
    assert(!fieldsOf(brokenA).includes('nextPlayerId'),
        '反例 A：移除 humanFlipRecord.nextPlayerId → 字段清单里查不到它（断言有效）');

    // 反例 B：拿掉 humanFlipRecord 里的 byPlayerId（复现事故当时的真实状态）
    // ⚠️ 必须**只改 humanFlipRecord 块内** —— 文件里还有 revealed[] 的 byPlayerId
    //    （那是另一条路径、本来就该有），用全局 replace 会替换错地方，
    //    反例就不红了（这条断言本身踩过一次坑）。
    const humanBlock = cfSrc.match(/const humanFlipRecord = \{[\s\S]*?\n    \};/)[0];
    const brokenHuman = humanBlock.replace(/^\s{8}byPlayerId: ctx\.openid,$/m, '        /* removed */');
    assert(!fieldsOf(cfSrc.replace(humanBlock, brokenHuman)).includes('byPlayerId'),
        '反例 B：移除 humanFlipRecord.byPlayerId → 字段清单里查不到它（断言有效）');
    assert(fieldsOf(cfSrc.replace(humanBlock, brokenHuman)).includes('score'),
        '反例 B 的对照组：无关字段 score 仍在（说明不是「什么都查不到」）');

    // 反例 C：AI 侧拿掉 byPlayerId（只改 AI 那一段）
    const brokenC = cfSrc.replace(/^\s{12}byPlayerId: f\.playerId,$/m, '            /* removed */');
    const aiM = brokenC.match(/flips = appendFlip\(flips, \{([\s\S]*?)\n        \}\);/);
    const aiF = aiM ? [...aiM[1].matchAll(/^\s{12}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((x) => x[1]) : [];
    assert(!aiF.includes('byPlayerId'),
        '反例 C：AI 侧移除 byPlayerId → 该侧字段清单里查不到它（断言有效）');
}

// ---------------------------------------------------------------------
console.log('\n场景 6：幂等重放分支返回体也必须带 byPlayerId');
// ---------------------------------------------------------------------
{
    const idem = cfSrc.match(/if \(revealed\[cellKey\]\) \{([\s\S]*?)return ok\(\{([\s\S]*?)\n        \}\);/);
    assert(!!idem, '存在「已翻开 → 幂等返回」分支');
    assert(idem ? /byPlayerId/.test(idem[2]) : false,
        '幂等返回体含 byPlayerId（漏了会让重复点击时归属变 undefined）');
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
