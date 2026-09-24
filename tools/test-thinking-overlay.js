/**
 * 回合表达与输入拦截回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 需求演进（务必按最新的一条理解）：
 *   · 2026-09-23：等待对手时不要「一行裸文字压在棋盘上」，改为半透明蒙版 + 胶囊；
 *   · **2026-09-24（现行）**：蒙版与「对手思考中」提醒**全部去掉**。
 *     用户反馈两点：① 预落子后我方落子即进入等待态，**即使这一手已经赢了**，
 *     蒙版也会先弹一下再弹胜利，很别扭；② 回合信息应当统一在 Game 的 HUD 里看。
 *     所以现在的形态是：
 *       - 棋盘上**不画任何东西**，只留一个不可见的输入拦截层（防误触穿透）；
 *       - 非我方回合靠 `setInputEnabled(false)` + 拦截层双重禁止操作；
 *       - 「该谁下」由 GameScene 的 `TurnLabel` 统一表达。
 *
 * 为什么仍值得写测试：
 *   ① 拦截层容易在重构中被一并删掉 —— 那样等待期间点棋盘会发出越权请求，
 *      服务端回「还没轮到你落子」，玩家看到的是报错；
 *   ② 拦截层必须走 newUINode（UI_2D 层）。裸 new Node() 落在 DEFAULT 层：
 *      收不到点击，而日志一切正常（本项目最经典的坑）；
 *   ③ 两款游戏共用基类，历史上有过「只改五子棋、忘了寻机头」的事故。
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

console.log('=== 回合表达与输入拦截回归测试 ===\n');

const baseSrc = read('assets/scripts/games/common/BoardBase.ts');
const baseCode = stripComments(baseSrc);
const gomokuSrc = read('assets/scripts/games/gomoku/GomokuBoard.ts');
const gomokuCode = stripComments(gomokuSrc);
const phSrc = read('assets/scripts/games/planehunt/PlaneHuntBoard.ts');
const phCode = stripComments(phSrc);
const gsSrc = read('assets/scripts/room/GameScene.ts');
const gsCode = stripComments(gsSrc);

// ---------------------------------------------------------------------
console.log('场景 1：棋盘上不再有任何可见的等待提示（2026-09-24 需求）');
// ---------------------------------------------------------------------
check('没有「对手思考中」文案残留（代码里）',
    !/对手思考中/.test(baseCode) && !/对手思考中/.test(gomokuCode) && !/对手思考中/.test(phCode),
    '棋盘上还有等待文案 —— 用户明确要求去掉，统一到 HUD');
check('没有蒙层颜色常量残留（THINKING_OVERLAY_COLOR 已删）',
    !/THINKING_OVERLAY_COLOR/.test(baseCode));
check('没有绘制胶囊/标签的节点（ThinkingChip / ThinkingLabel）',
    !/ThinkingChip/.test(baseCode) && !/ThinkingLabel/.test(baseCode));
check('拦截层不挂 Graphics（画东西就变成用户不要的那层遮挡）',
    !/ensureInputBlocker[\s\S]{0,900}addComponent\(Graphics\)/.test(baseCode),
    '拦截层里出现了 Graphics');

// ---------------------------------------------------------------------
console.log('\n场景 2：但必须保留「纯输入拦截层」（防误触穿透）');
// ---------------------------------------------------------------------
check('BoardBase 暴露 showThinking()（保留名称，不动各游戏调用点）',
    /public showThinking\(show: boolean\)/.test(baseCode));
check('懒建逻辑改名为 ensureInputBlocker()',
    /protected ensureInputBlocker\(\)/.test(baseCode));
check('重复调用是幂等的（已建则直接返回）',
    /if\s*\(this\._thinkingOverlay \|\| !this\._root\)/.test(baseCode));
check('拦截层带 BlockInputEvents',
    /newUINode\('WaitInputBlocker'\)[\s\S]{0,400}addComponent\(BlockInputEvents\)/.test(baseCode),
    '缺 BlockInputEvents —— 等待对手时点棋盘会触发「还没轮到你落子」');
check('showThinking 同时禁用棋盘交互（双保险）',
    /this\._interactive = !show/.test(baseCode));

// ---------------------------------------------------------------------
console.log('\n场景 3：层级安全（必须走 newUINode，否则收不到点击）');
// ---------------------------------------------------------------------
check('未使用裸 new Node() 建 UI 节点',
    !/new Node\(/.test(baseCode),
    '裸 new Node() 落在 DEFAULT 层 —— 收不到点击且日志正常，最难查的一类');

// ---------------------------------------------------------------------
console.log('\n场景 4：该谁下——统一由 GameScene 的 HUD 表达');
// ---------------------------------------------------------------------
check('HUD 回合文案区分「请落子 / 请稍候」',
    /你的回合 · 请落子/.test(gsSrc) && /对手回合 · 请稍候/.test(gsSrc),
    'HUD 回合文案未明确表达"现在能不能操作棋盘"');
check('回合渲染是三通道冗余（文案 + ◆圆点 + 昵称提色）',
    /_myTurnMark\.string = myTurn \? '◆' : ' '/.test(gsCode) &&
        /_myNameLabel\.color = myTurn \? THEME\.primary : THEME\.textDim/.test(gsCode),
    '回合表达退化成只靠一行文字，手机上容易看漏');

// ---------------------------------------------------------------------
console.log('\n场景 5：两款游戏都接上了（不能只改五子棋）');
// ---------------------------------------------------------------------
check('五子棋转发到共用实现',
    /public showThinking\(show: boolean\): void \{\s*this\._renderer\.showThinking\(show\);/.test(gomokuCode),
    '五子棋未接共用实现');
check('寻机头转发到共用实现',
    /this\._renderer\.showThinking\(show\)/.test(phCode),
    '寻机头未接 —— 它历史上这里**是空实现**，只打日志、界面什么都不显示');
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
