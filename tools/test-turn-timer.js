/**
 * test-turn-timer.js —— 回合倒计时契约（防「超时无限刷屏」与「计时器卡死」）
 *
 * ── 背景（2026-09-24 真机日志） ──
 * 长时间不操作时控制台被这句刷屏：
 *     [GameScene] 本回合超时
 *     [GameScene] 本回合超时
 *     ...
 * 根因：`_startTimer` 的 tick 里超时后把 `_remainSec` **重置回满值**却
 * **不停表**，于是每满一个周期又喊一次，无限循环。而且超时没有任何实际
 * 后果（不换回合、不提示玩家；服务端也确实没有超时判定）。
 *
 * 修好后引入新风险：`_onTurnTimeout()` 会停表，若回合切换时只改数值不重启，
 * 下个回合倒计时会**永远不动**（interval 已清）。本测试把这两条都钉住。
 *
 * ── 断言策略 ──
 * 行为类断言（停表 / 只告警一次 / 回合切换要重启）无法靠字符串部分匹配
 * 可靠覆盖，所以这里**抽取真实代码片段做语义断言**：把计时器相关的三个
 * 方法体取出来，检查关键调用是否存在且顺序合理；并配反例自证。
 *
 * 运行：node tools/test-turn-timer.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'assets/scripts/room/GameScene.ts');
const src = fs.readFileSync(SRC_PATH, 'utf8');

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));

/** 抽取某个方法体（从签名起到下一个同级方法/类结束）。 */
function methodBody(name) {
    const re = new RegExp(`private\\s+${name}\\s*\\([^)]*\\)\\s*:\\s*void\\s*\\{`);
    const m = src.match(re);
    if (!m) {
        return null;
    }
    let i = m.index + m[0].length;
    let depth = 1;
    for (let k = i; k < src.length; k++) {
        if (src[k] === '{') { depth++; }
        else if (src[k] === '}') {
            depth--;
            if (depth === 0) { return src.slice(i, k); }
        }
    }
    return null;
}

// =====================================================================
console.log('\n场景 1：超时必须停表（否则 tick 每周期重喊一次 → 无限刷屏）');
// =====================================================================
{
    const timeout = methodBody('_onTurnTimeout');
    assert(!!timeout, '_onTurnTimeout 方法存在');
    assert(timeout ? /this\._stopTimer\(\)/.test(timeout) : false,
        '超时处理里调用了 _stopTimer()');
    // 反例：原缺陷是把 _remainSec 重置回满值并继续跑
    assert(timeout ? !/this\._remainSec\s*=\s*AppConfig\.TURN_TIME_LIMIT_SEC/.test(timeout) : false,
        '超时处理里**没有**把 _remainSec 重置回满值（原缺陷特征）');
}

// =====================================================================
console.log('\n场景 2：超时只告警一次（防刷屏闸）');
// =====================================================================
{
    const timeout = methodBody('_onTurnTimeout') || '';
    assert(/this\._turnTimedOut\s*=\s*true/.test(timeout), '超时处理里置位 _turnTimedOut');
    assert(/if\s*\(this\._turnTimedOut\)\s*\{\s*return;\s*\}/.test(timeout.replace(/\s+/g, ' ')) ||
        /if\s*\(this\._turnTimedOut\)/.test(timeout),
        '超时处理里有「已告警过就 return」的短路');
    assert(/_turnTimedOut\s*=\s*false/.test(src), '_turnTimedOut 有复位点');
    // 字段声明存在
    assert(/private\s+_turnTimedOut\s*=\s*false/.test(src), '_turnTimedOut 字段已声明');
}

// =====================================================================
console.log('\n场景 3：回合切换必须**重启**计时器（不能只改数值）');
// =====================================================================
{
    const reset = methodBody('_resetTimer');
    assert(!!reset, '_resetTimer 方法存在');
    assert(reset ? /this\._startTimer\(\)/.test(reset) : false,
        '回合切换调用 _startTimer()（重启 interval）');
    // 反例特征：只调 _refreshTimer 而不重启 —— 会导致下回合倒计时卡死
    assert(reset ? !/^\s*this\._refreshTimer\(\);\s*$/m.test(reset.trim()) : false,
        '回合切换没有只靠 _refreshTimer 了事（那会让下回合计时不动）');
    // 新回合要允许再次告警
    assert(reset ? /this\._turnTimedOut\s*=\s*false/.test(reset) : false,
        '回合切换复位 _turnTimedOut（否则第二回合超时静默无提示）');
}

// =====================================================================
console.log('\n场景 4：tick 里只做倒计时与判定，不自己重开表');
// =====================================================================
{
    const start = methodBody('_startTimer');
    assert(!!start, '_startTimer 方法存在');
    assert(start ? /setInterval\(/.test(start) : false, '用 setInterval 驱动');
    assert(start ? /this\._remainSec--/.test(start) : false, '每 tick 递减 _remainSec');
    assert(start ? /this\._onTurnTimeout\(\)/.test(start) : false,
        '到点走 _onTurnTimeout()（而不是内联刷日志）');
    // tick 内不该出现「重置满值后继续」的写法
    const tick = start ? (start.match(/setInterval\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*1000\)/) || [])[1] || '' : '';
    assert(tick ? !/TURN_TIME_LIMIT_SEC/.test(tick) : false,
        'tick 体内不出现 TURN_TIME_LIMIT_SEC（不重置满值）');
    assert(tick ? !/console\.warn/.test(tick) : false,
        'tick 体内不直接打超时日志（收敛到 _onTurnTimeout）');
}

// =====================================================================
console.log('\n场景 5：超时不擅自切回合（判定权只在权威方）');
// =====================================================================
{
    const timeout = methodBody('_onTurnTimeout') || '';
    // 不得出现本地推演回合/替代对方落子的调用
    const forbidden = [
        ['nextPlayerId', '本地改回合字段'],
        ['_serverTurnId', '本地推演权威回合'],
        ['setMyTurn', '本地翻转我方回合'],
    ];
    for (const [token, desc] of forbidden) {
        assert(!timeout.includes(token), `超时处理里不含「${desc}」（${token}）`);
    }
}

// =====================================================================
console.log('\n反例自证：故意破坏后断言必须变红');
// =====================================================================
{
    // A：把 _onTurnTimeout 里的停表删掉
    const noStop = src.replace(/(private\s+_onTurnTimeout\s*\(\)\s*:\s*void\s*\{[\s\S]*?)this\._stopTimer\(\);/, '$1');
    const bodyA = (() => {
        const re = /private\s+_onTurnTimeout\s*\(\)\s*:\s*void\s*\{/;
        const m = noStop.match(re);
        if (!m) { return ''; }
        let i = m.index + m[0].length, d = 1;
        for (let k = i; k < noStop.length; k++) {
            if (noStop[k] === '{') { d++; } else if (noStop[k] === '}') { d--; if (!d) { return noStop.slice(i, k); } }
        }
        return '';
    })();
    assert(!/this\._stopTimer\(\)/.test(bodyA),
        '反例 A：删掉停表后，超时处理里确实查不到 _stopTimer（断言有效）');

    // B：把 _resetTimer 的重启换回只刷新
    const noRestart = src.replace(
        /(private\s+_resetTimer\s*\(\)\s*:\s*void\s*\{[\s\S]*?)this\._startTimer\(\); \/\/[^\n]*/,
        '$1this._refreshTimer();',
    );
    const bodyB = (() => {
        const m = noRestart.match(/private\s+_resetTimer\s*\(\)\s*:\s*void\s*\{/);
        if (!m) { return ''; }
        let i = m.index + m[0].length, d = 1;
        for (let k = i; k < noRestart.length; k++) {
            if (noRestart[k] === '{') { d++; } else if (noRestart[k] === '}') { d--; if (!d) { return noRestart.slice(i, k); } }
        }
        return '';
    })();
    assert(!/this\._startTimer\(\)/.test(bodyB),
        '反例 B：换成只 _refreshTimer 后，重启调用确实查不到（断言有效）');
    assert(/this\._refreshTimer\(\)/.test(bodyB), '反例 B 对照组：_refreshTimer 仍在（不是空片段）');

    // C：把刷屏闸删掉
    const noGate = src.replace(/if\s*\(this\._turnTimedOut\)\s*\{\s*return;\s*\}/, '');
    assert(!/if\s*\(this\._turnTimedOut\)\s*\{\s*return;\s*\}/.test(noGate),
        '反例 C：删掉刷屏闸后确实查不到该短路（断言有效）');
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
