/**
 * 结算弹窗「无灰色蒙版」回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 需求（2026-09-23）：出游戏结果时**不要灰色蒙版**，只显示结果白卡片。
 *
 * 为什么值得写测试：这件事有一个很容易踩回去的坑 ——
 * 拦截层（ResultMask）同时是 ResultPanel 的**父节点**，所以不能删；
 * 它也不能 active=false（会连白卡片一起隐藏）。
 * 正确做法是「容器保留、alpha=0 不画底色」。
 * 后来者若「顺手清理」掉这个看似多余的容器，结算界面就整个不见了。
 *
 * 本测试用静态断言锁住这三条不变式：
 *   ① 拦截层存在且铺满可视区；
 *   ② 它的 alpha 为 0（不画灰色）；
 *   ③ 它没有被 active=false，且 BlockInputEvents 仍在（防误触棋盘）。
 *
 * 运行：node tools/test-result-dialog.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const uiManagerPath = path.join(ROOT, 'assets', 'scripts', 'core', 'UIManager.ts');
const themePath = path.join(ROOT, 'assets', 'scripts', 'config', 'UITheme.ts');

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

console.log('=== 结算弹窗无蒙版回归测试 ===\n');

const src = fs.readFileSync(uiManagerPath, 'utf8');
const themeSrc = fs.readFileSync(themePath, 'utf8');

// 只取 showResultDialog 函数体，避免误命中 showChoiceDialog 的蒙版
const fnStart = src.indexOf('public showResultDialog');
const fnEnd = src.indexOf('private _reasonText');
let body = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';

// 断言只针对**代码**，必须剥掉注释 —— 说明「为什么改」的注释里会引用
// overlayColor(140) 这个旧值，否则测试会被自己的文档误伤（已踩过一次）。
const code = body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))          // 行注释
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');              // 块注释

console.log('场景 1：定位到 showResultDialog 函数体');
check('函数体截取成功', body.length > 200, `截取到 ${body.length} 字符`);

console.log('\n场景 2：拦截层不变式（不能删、不能 active=false）');
check('结果弹窗创建了 ResultMask 容器', /createRect\('ResultMask'/.test(code),
    'ResultMask 被删除 —— 它是 ResultPanel 的父节点，删了白卡片就没地方挂');
check('拦截层铺满可视区', /view\.getVisibleSize\(\)\.width/.test(code)
    && /view\.getVisibleSize\(\)\.height/.test(code));
check('保留了 BlockInputEvents（防误触底下棋盘）',
    /addComponent\(BlockInputEvents\)/.test(code),
    '缺 BlockInputEvents 会导致结算时还能点棋盘落子');
check('拦截层未被 active=false', !/mask\.active\s*=\s*false/.test(code),
    'active=false 会连子节点（白卡片）一起隐藏');

console.log('\n场景 3：不画灰色（alpha=0）');
check('拦截层底色 alpha 为 0', /overlayColor\(0\)/.test(code),
    '仍是 overlayColor(140) —— 灰色蒙版还在');
check('残留的 140 已不存在（注释不算）', !/overlayColor\(140\)/.test(code),
    '代码里还有 overlayColor(140) 残留');

console.log('\n场景 4：白卡片仍挂在拦截层下（居中依赖父节点）');
check('ResultPanel 仍是 mask 的子节点', /mask\.addChild\(panel\)/.test(code));

console.log('\n场景 5：主题侧语义（alpha=0 确实等于「不画」）');
check('overlayColor 接受 alpha 参数', /export function overlayColor\(alpha\s*=\s*\d+\)/.test(themeSrc));
check('createRect 在 alpha=0 时跳过绘制但仍挂 UITransform',
    /if\s*\(color\.a\s*>\s*0\)/.test(fs.readFileSync(
        path.join(ROOT, 'assets', 'scripts', 'core', 'UIFactory.ts'), 'utf8')),
    'createRect 若在 alpha=0 时连 UITransform 都不挂，点击拦截会失效');

console.log(`\n${fail === 0 ? 'ALL_RESULT_DIALOG_TESTS_PASSED' : 'RESULT_DIALOG_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
