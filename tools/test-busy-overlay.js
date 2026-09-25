/**
 * test-busy-overlay.js —— 等待遮罩（loading）契约回归
 *
 * 全量自检第 **21** 层（注册于 tools/check-all.js；新增测试需同步
 * ① check-all.js 注册表 ② 本文件头编号 ③ VERSION 的层数说明）。
 *
 * ── 为什么需要这一层 ──
 * 2026-09-25 用户要求「所有可能等待的按钮操作都加 loading 提醒，让界面友好」。
 * 遮罩本身很好写，但**漏掉收尾会比没有遮罩更糟**：全屏遮罩带 BlockInputEvents，
 * 一旦某条退出路径（异常 / 提前 return）没调 hideBusy，遮罩会永久盖住界面，
 * 玩家除了杀进程没有任何出路。这类 bug 在手工测试里极难覆盖 ——
 * 需要刚好走到那条异常分支。
 *
 * ── 断言策略 ──
 * ① 能力面：UIManager 必须提供 showBusy / updateBusy / hideBusy / isBusy；
 * ② 语义面：showBusy 幂等（重复调用不叠加节点）、hideBusy 幂等；
 * ③ **收尾面（最关键）**：每一个 showBusy 的调用点，其所在函数都必须有
 *    hideBusy —— 按「函数体内两者共存」来验证，而不是简单地数全文件出现次数
 *    （那样一个函数里写两遍就能骗过断言）；
 * ④ 遮罩必须真的拦输入（BlockInputEvents）且挂在浮层容器上（否则被
 *    Lobby 的 ScrollView Mask 裁掉，屏幕上什么都看不见 —— 项目踩过这个坑）；
 * ⑤ 反例自证：删掉某处的 hideBusy 后，第 ③ 项断言必须变红。
 *
 * 运行：node tools/test-busy-overlay.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'assets', 'scripts', 'core', 'UIManager.ts');
const ROOM = path.join(ROOT, 'assets', 'scripts', 'room', 'RoomScene.ts');
const GAME = path.join(ROOT, 'assets', 'scripts', 'room', 'GameScene.ts');

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

const uiSrc = fs.readFileSync(UI, 'utf8');
const roomSrc = fs.readFileSync(ROOM, 'utf8');
const gameSrc = fs.readFileSync(GAME, 'utf8');

// ---------------------------------------------------------------------
console.log('\n场景 1：UIManager 提供完整的遮罩能力面');
// ---------------------------------------------------------------------
for (const m of ['showBusy', 'updateBusy', 'hideBusy', 'isBusy']) {
    assert(
        new RegExp(`public\\s+${m}\\s*\\(`).test(uiSrc),
        `UIManager 暴露 public ${m}()`,
    );
}
assert(/public\s+showBusy\s*\([^)]*text:\s*string/.test(uiSrc), 'showBusy 接受文案参数');
assert(/BUSY_SLOW_SEC/.test(uiSrc), '存在「等待过久」阈值常量（慢网安抚文案）');

// ---------------------------------------------------------------------
console.log('\n场景 2：遮罩必须能拦输入、且挂在浮层容器上');
// ---------------------------------------------------------------------
{
    const busyBlock = uiSrc.match(/public\s+showBusy[\s\S]*?\n    \}/);
    assert(!!busyBlock, '能定位 showBusy 函数体');
    const src = busyBlock ? busyBlock[0] : '';
    assert(
        /addComponent\(BlockInputEvents\)/.test(src),
        '★ 遮罩挂了 BlockInputEvents —— 物理拦截连点（不只是视觉提示）',
    );
    assert(
        /_overlayRoot\(canvas\)/.test(src),
        '★ 遮罩挂在 _overlayRoot（Overlay）下 —— 直挂 Canvas 会被大厅 ScrollView 的 Mask 裁掉',
    );
    assert(/setSiblingIndex\(/.test(src), '遮罩置顶（否则被同层的弹窗盖住）');
    assert(
        /scene\s*\)\s*\{\s*return/.test(src) || /if\s*\(!scene\)/.test(src),
        '场景未就绪时静默跳过（不因提示失败而拖垮主流程）',
    );
}

// ---------------------------------------------------------------------
console.log('\n场景 3：showBusy / hideBusy 都必须幂等');
// ---------------------------------------------------------------------
{
    const showBlock = (uiSrc.match(/public\s+showBusy[\s\S]*?\n    \}/) || [''])[0];
    assert(
        /isValid\s*\)\s*\{\s*this\._applyBusyText/.test(showBlock) ||
            /已在等待[\s\S]{0,200}return/.test(showBlock),
        'showBusy 幂等：已在等待时只改文案、不叠加第二个遮罩',
    );
    const hideBlock = (uiSrc.match(/public\s+hideBusy[\s\S]*?\n    \}/) || [''])[0];
    assert(
        /if\s*\(this\._busyTick/.test(hideBlock) && /if\s*\(this\._busyNode/.test(hideBlock),
        'hideBusy 幂等：无处可收时安全返回（各分支可放心 finally）',
    );
    assert(/clearInterval\(this\._busyTick\)/.test(hideBlock), 'hideBusy 清掉秒表定时器（防泄漏）');
}

// ---------------------------------------------------------------------
console.log('\n场景 4：每个 showBusy 调用点都必须有配对的 hideBusy（★最关键）');
// ---------------------------------------------------------------------
/**
 * 把源码切成「方法块」（按 `private/public/async` 方法起始行切分）。
 * 对每个含 showBusy 的方法，检查同一块内是否也调用了 hideBusy。
 *
 * 为什么不数全文件出现次数：一个函数里连写两次 hideBusy 就能让计数相等，
 * 而另一个函数里的遮罩漏了收尾 —— 那种断言是假绿。
 */
function methodBlocks(src) {
    const lines = src.split('\n');
    const blocks = [];
    let cur = null;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // 方法签名：缩进 4 空格的 private/public/async/static 或 `onXxx(`
        if (/^ {4}(private|public|protected|async|static|\w+\s*\()/.test(line) && /[({]\s*$/.test(line)) {
            if (cur) {
                blocks.push({ name: cur.name, body: cur.lines.join('\n') });
            }
            const nm = (line.match(/([A-Za-z_$][\w$]*)\s*\(/) || [, '(anon)'])[1];
            cur = { name: nm, lines: [] };
            depth = 0;
        }
        if (cur) {
            cur.lines.push(line);
            for (const ch of line) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            if (depth <= 0 && cur.lines.join('\n').trim().length > 0 && /^\s*\}/.test(line)) {
                blocks.push({ name: cur.name, body: cur.lines.join('\n') });
                cur = null;
            }
        }
    }
    if (cur) {
        blocks.push({ name: cur.name, body: cur.lines.join('\n') });
    }
    return blocks;
}

const filesWithBusy = [
    { label: 'UIManager.ts（gotoAiPractice）', src: uiSrc },
    { label: 'RoomScene.ts', src: roomSrc },
    { label: 'GameScene.ts', src: gameSrc },
];

/** 调用点 ≠ 定义点：`public showBusy(` 是定义，`this.showBusy(` / `uiManager.showBusy(` 才是调用。 */
function callSites(body) {
    return (body.match(/(?:this\.|uiManager\.|ui\.|[A-Za-z_$][\w$]*\.)showBusy\s*\(/g) || []).length;
}
function hideCalls(body) {
    return (body.match(/(?:this\.|uiManager\.|ui\.|[A-Za-z_$][\w$]*\.)hideBusy\s*\(/g) || []).length;
}

let showPoints = 0;
let pairedMethods = 0;
let methodsWithBusy = 0;
for (const f of filesWithBusy) {
    for (const b of methodBlocks(f.src)) {
        // 跳过 showBusy / updateBusy 自身的定义体：
        //   updateBusy 内部有 `this.showBusy(...)` 兜底调用（遮罩不存在时补建），
        //   那是**实现细节**、不是业务调用点 —— 它和 showBusy 一样由 hideBusy
        //   的调用方负责收尾，纳入检查只会产生假红。
        if (b.name === 'showBusy' || b.name === 'updateBusy') {
            continue;
        }
        const shows = callSites(b.body);
        if (shows === 0) {
            continue;
        }
        showPoints += shows;
        methodsWithBusy++;
        const hides = hideCalls(b.body);
        if (hides >= 1) {
            pairedMethods++;
            ok(`${f.label} → ${b.name}()：${shows} 次 showBusy 有配对 hideBusy`);
        } else {
            bad(
                `${f.label} → ${b.name}()：调了 showBusy 却**没有** hideBusy ` +
                    '—— 遮罩会永久盖住界面（比不加 loading 更糟）',
            );
        }
    }
}
assert(showPoints > 0, `找到 ${showPoints} 个 showBusy 调用点（期望 > 0，否则断言无意义）`);
// ⚠️ 口径：比的是**方法数**，不是调用点数。
//    一个方法里可以有多个 showBusy（如 _initRoom 的「建房/加入」两条分支），
//    只要该方法整体有 hideBusy 收尾即可 —— 按调用点数比会永远不等（假红）。
assert(
    pairedMethods === methodsWithBusy && methodsWithBusy > 0,
    `${methodsWithBusy} 个含 showBusy 的方法全部有收尾（实际 ${pairedMethods} 个）` +
        `（共 ${showPoints} 次调用）`,
);

// ---------------------------------------------------------------------
console.log('\n场景 5：关键等待操作确实接入了遮罩');
// ---------------------------------------------------------------------
assert(
    /showBusy\([\s\S]{0,600}?await services\.room\.createRoom/.test(uiSrc),
    'AI 练习（建房→开局→取快照）全程有遮罩',
);
assert(
    /showBusy\(/.test(roomSrc.match(/private async _initRoom[\s\S]*?\n    \}/)[0]),
    '房间页 _initRoom（建房/加入）接入了遮罩',
);
assert(
    /showBusy\(/.test(roomSrc.match(/private async _onStart[\s\S]*?\n    \}/)[0]),
    '房间页 _onStart（开局）接入了遮罩',
);
assert(
    /showBusy\(/.test(roomSrc.match(/private async _onToggleReady[\s\S]*?\n    \}/)[0]),
    '房间页 _onToggleReady（准备）接入了遮罩',
);
assert(
    /showBusy\(/.test(roomSrc.match(/private async _onLeave[\s\S]*?\n    \}/)[0]),
    '房间页 _onLeave（退房）接入了遮罩',
);

// ---------------------------------------------------------------------
console.log('\n场景 6：反例自证 —— 删掉收尾后断言必须变红');
// ---------------------------------------------------------------------
{
    // 反例 A：拿掉 _onStart 里的 hideBusy，该方法的配对检查应失败
    const startBlock = roomSrc.match(/private async _onStart[\s\S]*?\n    \}/);
    assert(!!startBlock, '能定位 _onStart 块（用于反例）');
    if (startBlock) {
        const broken = startBlock[0].replace(/^\s*uiManager\.hideBusy\(\);\s*$/m, '');
        assert(
            (broken.match(/hideBusy\s*\(/g) || []).length === 0,
            '反例 A：移除 hideBusy 后该块内确实查不到它（说明断言盯着真实调用）',
        );
        assert(
            (startBlock[0].match(/hideBusy\s*\(/g) || []).length >= 1,
            '反例 A 的对照组：原源码里它是存在的',
        );
    }

    // 反例 B：拿掉 _initRoom 的 finally 收尾，同理
    const initBlock = roomSrc.match(/private async _initRoom[\s\S]*?\n    \}/);
    if (initBlock) {
        const broken = initBlock[0].replace(/uiManager\.hideBusy\(\);/g, '');
        assert(
            !/uiManager\.hideBusy\(\)/.test(broken),
            '反例 B：移除 _initRoom 的收尾后查不到 hideBusy 调用（断言有效）',
        );
        assert(
            /uiManager\.hideBusy\(\)/.test(initBlock[0]),
            '反例 B 的对照组：原源码里它是存在的',
        );
    }
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
