/**
 * 「对手思考中」遮罩回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 需求（2026-09-23）：等待对手时不要显示一行裸文字压在棋盘上（太突兀），
 * 改为半透明蒙版 + 居中胶囊标签。
 *
 * 为什么值得写测试：
 *   ① 这个改动把实现从「各游戏自己建 Label」上移到共用基类 BoardBase，
 *      后来者很容易只改五子棋、忘了寻机头（历史上寻机头这里**是空实现**，
 *      只打日志、界面上什么都不显示）；
 *   ② 遮罩必须带 BlockInputEvents 且同时禁用棋盘输入 —— 否则等待对手期间
 *      点棋盘会发出越权请求，服务端回「还没轮到你落子」（玩家看到的就是报错）；
 *   ③ 建节点必须走 newUINode（UI_2D 层）。用裸 new Node() 会落在 DEFAULT 层：
 *      相机看不见、也收不到点击，而日志一切正常（本项目最经典的坑）。
 *
 * 运行：node tools/test-thinking-overlay.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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

/** 剥掉注释：断言针对代码，说明性注释里会引用旧实现（已踩过一次）。 */
function stripComments(src) {
    return src
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

console.log('=== 「对手思考中」遮罩回归测试 ===\n');

const baseSrc = read('assets/scripts/games/common/BoardBase.ts');
const baseCode = stripComments(baseSrc);
const gomokuSrc = read('assets/scripts/games/gomoku/GomokuBoard.ts');
const gomokuCode = stripComments(gomokuSrc);
const phSrc = read('assets/scripts/games/planehunt/PlaneHuntBoard.ts');
const phCode = stripComments(phSrc);

// ---------------------------------------------------------------------
console.log('场景 1：共用基类提供遮罩实现（两款游戏一处维护）');
// ---------------------------------------------------------------------
check('BoardBase 暴露 showThinking()', /public showThinking\(show: boolean\)/.test(baseCode),
    '遮罩未上移到基类，两款游戏会各写一套');
check('BoardBase 有懒建逻辑 ensureThinkingOverlay()',
    /protected ensureThinkingOverlay\(\)/.test(baseCode));
check('重复调用是幂等的（已建则直接返回）',
    /if\s*\(this\._thinkingOverlay \|\| !this\._root\)/.test(baseCode));

// ---------------------------------------------------------------------
console.log('\n场景 2：形态正确（半透明蒙层 + 居中胶囊，不再是裸文字）');
// ---------------------------------------------------------------------
check('创建了蒙层节点 ThinkingOverlay', /newUINode\('ThinkingOverlay'\)/.test(baseCode));
check('创建了居中胶囊 ThinkingChip', /newUINode\('ThinkingChip'\)/.test(baseCode));
check('蒙层用深色半透明（白底上才压得住）',
    /THINKING_OVERLAY_COLOR/.test(baseCode) && /new Color\(16, 19, 26, \d+\)/.test(baseCode),
    '蒙层色缺失或不是深色');
check('文字仍是「对手思考中…」', /对手思考中…/.test(baseSrc));
check('挂在与棋盘同级/更外的宿主上（能盖住留白，而非只盖格子）',
    /this\._root\.parent \?\? this\._root/.test(baseCode));

// ---------------------------------------------------------------------
console.log('\n场景 3：必须挡点击（否则等待期间误点会发出越权请求）');
// ---------------------------------------------------------------------
check('蒙层带 BlockInputEvents', /addComponent\(BlockInputEvents\)/.test(baseCode),
    '缺 BlockInputEvents —— 等待对手时点棋盘会触发「还没轮到你落子」');
check('showThinking 同时禁用棋盘交互（双保险）',
    /this\._interactive = !show/.test(baseCode));

// ---------------------------------------------------------------------
console.log('\n场景 4：层级安全（必须走 newUINode，否则相机看不见）');
// ---------------------------------------------------------------------
check('未使用裸 new Node() 建 UI 节点',
    !/new Node\(/.test(baseCode),
    '裸 new Node() 落在 DEFAULT 层 —— 相机看不见且收不到点击，日志却正常');

// ---------------------------------------------------------------------
console.log('\n场景 5：两款游戏都接上了（不能只改五子棋）');
// ---------------------------------------------------------------------
check('五子棋转发到共用遮罩', /public showThinking\(show: boolean\): void \{\s*this\._renderer\.showThinking\(show\);/.test(gomokuCode),
    '五子棋未接共用遮罩');
check('寻机头转发到共用遮罩', /this\._renderer\.showThinking\(show\)/.test(phCode),
    '寻机头未接共用遮罩 —— 它原先只打日志、界面上什么都不显示');
check('五子棋已移除旧的裸 Label 实现',
    !/_thinkingLabel/.test(gomokuCode) && !/_thinkingNode/.test(gomokuCode),
    '旧 _thinkingLabel/_thinkingNode 残留');
check('两个 renderer 都继承 BoardBase',
    /class GomokuBoardRenderer extends BoardBase/.test(gomokuCode)
    && /class PlaneHuntRenderer extends BoardBase/.test(phCode),
    '继承关系变化会让 showThinking 失效');

console.log(`\n${fail === 0 ? 'ALL_THINKING_OVERLAY_TESTS_PASSED' : 'THINKING_OVERLAY_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
