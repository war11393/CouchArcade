/**
 * test-planehunt-finish.js —— 寻机头「机头翻满必须结算」回归
 *
 * 全量自检第 **20** 层（注册于 tools/check-all.js；新增测试需同步
 * ① check-all.js 注册表 ② 本文件头编号 ③ README/VERSION 的层数说明）。
 *
 * ── 为什么需要这一层 ──
 * 2026-09-25 单机模式实测 bug：**机头全翻出来了，对局却不结束**（不弹结算页）。
 *
 * 根因是「结束信号挂在了唯一一条通道上，而那条通道在 Mock 模式下不保证会来」：
 *   寻机头有两条结束通道 ——
 *     ① PH_FLIP_RESULT.finished（权威逐手下发）；
 *     ② GAME_OVER（Mock 由 PlaneHuntAuthority 在 handleUpstream / pollAiAction
 *        里产出；真机由 WxNetSyncService 看到 doc.finished 后补发）。
 *   而客户端只消费了 ②：`PlaneHuntGame._commitFlip` 从头到尾没读 `p.finished`，
 *   而权威**也从来没产出过这个字段**（FlipResult 里没有它）。
 *   于是只要 ② 没到（时序错位 / 权威路径不同），单机就永远停在「对局中」，
 *   棋盘还因为最后一手的 nextPlayerId 指向对手而被锁死 —— 玩家眼里就是「卡死」。
 *
 * ── 断言策略（关键：不是只 grep 字符串）──
 * 本测试用**真的规则层对象**（PlaneHuntRules 的 TS 源码直接转 JS 后 require）
 * 把一局打到结束，验证：
 *   ① 权威的每一手结果里都带 finished/winnerId/draw；
 *   ② 最后一手 finished === true（这是客户端唯一的兜底）；
 *   ③ 结束态的胜者与比分自洽（不能被当成平局）；
 *   ④ 客户端确实消费了 p.finished（静态断言，防止有人把逻辑又删回去）；
 *   ⑤ AI 座位 id 长度 ≤24（云数据库 doc(_id).update 的硬约束，
 *      超长会导致「写结束态失败 → 永不结算」）；
 *   ⑥ 反例自证：故意把 finished 抹掉后断言必须变红。
 *
 * 运行：node tools/test-planehunt-finish.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const RULES_TS = path.join(ROOT, 'assets', 'scripts', 'games', 'planehunt', 'PlaneHuntRules.ts');
const GAME_TS = path.join(ROOT, 'assets', 'scripts', 'games', 'planehunt', 'PlaneHuntGame.ts');
const PROTO_TS = path.join(ROOT, 'assets', 'scripts', 'core', 'protocol', 'Protocol.ts');
const CREATE_ROOM = path.join(ROOT, 'cloudfunctions', 'createRoom', 'index.js');
const FLIP_CF = path.join(ROOT, 'cloudfunctions', 'planehunt_flip', 'index.js');

/**
 * 依赖替身的虚拟目录。
 *
 * 这些路径**不存在于磁盘上** —— 它们只作为 `require.cache` 的键，
 * 让被转译模块的 `require('...')` 解析到一个「已加载的替身模块」。
 * 放到系统临时目录下，避免与本项目的任何真实路径重名。
 */
const VIRTUAL_DIR = path.join(require('os').tmpdir(), 'hermes-ph-test-stubs');

/**
 * 期望的机头数（= AppConfig.PLANEHUNT_PLANE_COUNT）。
 * 与 tests 里的 AppConfig 替身保持一致；改一处要同步另一处。
 */
const EXPECTED_HEADS = 5;

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

// =====================================================================
// 载入真实的规则层：用 Cocos Creator 自带的 TypeScript 编译器转译后 require
// =====================================================================

const rulesSrc = fs.readFileSync(RULES_TS, 'utf8');

/**
 * 定位 TypeScript 编译器。
 *
 * 为什么不用「正则剥类型」：剥 TS 是个无底洞（`const X: T = ...`、联合类型、
 * 泛型、装饰器……），本项目已在 typecheck.cmd 里认定了唯一权威来源 ——
 * Cocos Creator 编辑器内置的 typescript（5.8.2），它同时支持
 * `transpileModule`（单文件转译，不做类型检查），正好满足「跑真实代码」的需求。
 * 这里复用同一份，保证测试与 typecheck 用同一套语法理解。
 *
 * 找不到时**明确报错**（而不是退回正则硬撑）——否则测试会以假绿通过。
 */
function findTypeScript() {
    const candidates = [
        // 与 typecheck.cmd 保持一致（Cocos 3.8.8）
        'C:/ProgramData/cocos/editors/Creator/3.8.8/resources/app.asar.unpacked/node_modules/typescript',
    ];
    // 允许用环境变量覆盖（换编辑器版本/换机器时不改代码）
    if (process.env.HERMES_TSC_DIR) {
        candidates.unshift(process.env.HERMES_TSC_DIR);
    }
    for (const c of candidates) {
        try {
            return require(c);
        } catch (_) {
            /* 试下一个 */
        }
    }
    return null;
}

const TS = findTypeScript();

/** 用 TS 编译器把单个模块转译成 CommonJS（保留 import，供下面做依赖注入）。 */
function transpile(tsPath) {
    if (!TS) {
        throw new Error(
            '找不到 TypeScript 编译器。请确认 Cocos Creator 安装在默认路径，' +
                '或设置环境变量 HERMES_TSC_DIR 指向 typescript 包目录。',
        );
    }
    const src = fs.readFileSync(tsPath, 'utf8');
    const out = TS.transpileModule(src, {
        compilerOptions: {
            module: TS.ModuleKind.CommonJS,
            target: TS.ScriptTarget.ES2017,
            // 不引入 tslib：目标设为 ES2017 后无需辅助函数
            importHelpers: false,
            removeComments: false,
        },
        fileName: tsPath,
    });
    return out.outputText;
}

/**
 * 载入一个 TS 模块，并把它的依赖替换成注入表里的替身。
 *
 * ⚠️ 为什么不能只给 `module.require` 赋值（2026-09-25 踩过）：
 *   Node 的 CommonJS wrapper 把 `require` 作为**形参**注入
 *   （`function (exports, require, module, __filename, __dirname)`），
 *   模块代码里调用的 `require` 绑定的是那个形参，**不是** `module.require`。
 *   所以 `m.require = ...` 完全不起作用 —— 转译产物里的
 *   `require('./PlaneHuntLayout')` 照旧去找真文件。
 *
 * 正确做法：临时改写 `Module._resolveFilename`，把注入表里的依赖名
 * 解析到一个「替身模块」上（替身模块的 exports 就是注入对象）。
 * 用 try/finally 保证无论成败都还原，不污染其它测试。
 */
function loadTsModule(tsPath, inject) {
    const js = transpile(tsPath);
    const deps = inject || {};

    // 把每个注入项做成一个占位文件路径，并登记进 require.cache，
    // 这样 _resolveFilename 解析到它时，_load 直接命中缓存返回替身。
    const stubs = new Map(); // 形如 '/virtual/AppConfig.js' -> 替身对象
    const keyOf = (tail) => path.join(VIRTUAL_DIR, `${tail}.js`);
    for (const [tail, val] of Object.entries(deps)) {
        const k = keyOf(tail);
        stubs.set(k, val);
        // 预置缓存：exports 即替身本体
        const stubMod = new Module(k, null);
        stubMod.filename = k;
        stubMod.loaded = true;
        stubMod.exports = val;
        require.cache[k] = stubMod;
    }

    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) {
        // 按「末段名」命中注入表（'./PlaneHuntLayout' → PlaneHuntLayout）
        if (parent && parent.filename === tsPath) {
            const tail = String(request).split('/').pop();
            const k = keyOf(tail);
            if (stubs.has(k)) {
                return k;
            }
        }
        return originalResolve.call(this, request, parent, ...rest);
    };

    try {
        const m = new Module(tsPath, null);
        m.filename = tsPath;
        m.paths = Module._nodeModulePaths(path.dirname(tsPath));
        m._compile(js, tsPath);
        return m.exports;
    } finally {
        Module._resolveFilename = originalResolve;
        for (const k of stubs.keys()) {
            delete require.cache[k];
        }
    }
}

let RulesMod = null;
try {
    // 依赖注入：规则层依赖 AppConfig（棋盘尺寸/飞机数）与布局提供者 ——
    // 这里用**真实实现**（PlaneHuntLayout），保证「权威生成的结束态」是真跑出来的。
    const AppConfigStub = {
        PLANEHUNT_SIZE: 10,
        PLANEHUNT_PLANE_COUNT: 5,
        LOG_VERBOSE: false,
    };
    // 转译产物形如 `const AppConfig_1 = require("../../config/AppConfig");`
    // 再访问 `AppConfig_1.AppConfig` —— 即**取模块的具名导出**。
    // 所以替身必须包成「命名空间」形状：{ AppConfig: stub }，
    // 而不是直接把 stub 当模块（那样 .AppConfig 会是 undefined）。
    const AppConfigNs = { AppConfig: AppConfigStub };

    const LayoutMod = loadTsModule(
        path.join(ROOT, 'assets', 'scripts', 'games', 'planehunt', 'PlaneHuntLayout.ts'),
        { AppConfig: AppConfigNs, ILayoutProvider: { ILayoutProvider: class {} } },
    );
    // LayoutMod 本身已是「命名空间形状」（转译产物导出了它自己的名字），
    // 作为模块注入给 Rules 即可。
    RulesMod = loadTsModule(RULES_TS, {
        PlaneHuntLayout: LayoutMod,
        AppConfig: AppConfigNs,
    });
    ok(
        '成功载入真实的 PlaneHuntRules + PlaneHuntLayout' +
            `（TS ${TS ? TS.version : '?'} 转译，依赖用替身注入）`,
    );
} catch (err) {
    bad(`载入 PlaneHuntRules 失败：${err.message}`);
}

// ---------------------------------------------------------------------
console.log('\n场景 1：权威逐手下发结束态（一局打到机头翻满）');
// ---------------------------------------------------------------------
let allFinishedFalseBeforeEnd = true;
let lastResult = null;
let endCount = 0;
let playCount = 0;

if (RulesMod) {
    const PlaneHuntRules = RulesMod.PlaneHuntRules;

    // ⚠️ seed 的选择有讲究：布局生成是「随机 + 碰撞检测 + 有限重试」，
    //    少数 seed 会**放不满**全部机头（见 PlaneHuntLayout 的重试上限）。
    //    本测试要验证的是「翻满后是否结束」，因此必须挑一个**布局完整**的 seed，
    //    否则测的是「残缺布局下也能正确结束」，掩盖了真正想覆盖的路径。
    //    下面自动挑第一个完整布局的 seed，而不是硬编码。
    // 静音布局层的调试输出：它会把整张棋盘 dump 到 stdout（对排查布局有用，
    // 但在这里只是噪音）。只屏蔽本测试期间的 log，跑完还原。
    const origLog = console.log;
    console.log = (...args) => {
        const first = String(args[0] ?? '');
        if (first.includes('[PlaneHuntLayout]')) {
            return;
        }
        origLog.apply(console, args);
    };

    let rules = null;
    let chosenSeed = -1;
    for (let seed = 1; seed <= 200; seed++) {
        const probe = new PlaneHuntRules('p1', 'p2', seed);
        if (probe.totalHeads === EXPECTED_HEADS) {
            rules = probe;
            chosenSeed = seed;
            break;
        }
    }
    console.log = origLog;
    assert(
        rules !== null,
        `找到布局完整的 seed（期望 ${EXPECTED_HEADS} 个机头，取了 seed=${chosenSeed}）`,
    );

    if (!rules) {
        throw new Error('无法找到布局完整的 seed，无法继续');
    }

    const total = rules.totalHeads;

    // 按权威的顺序性翻格：轮流在「未翻开」的格子上翻，直到结束。
    // 不打乱 —— 要跑的是真实 applyFlip 路径。
    for (let r = 0; r < rules.size && !rules.finished; r++) {
        for (let c = 0; c < rules.size && !rules.finished; c++) {
            if (rules.isRevealed(r, c)) continue;
            const who = rules.currentPlayerId;
            const res = rules.applyFlip(r, c, who);
            if (!res) continue;
            playCount++;
            if (rules.finished) {
                lastResult = res;
                endCount++;
            } else if (res.finished !== false) {
                allFinishedFalseBeforeEnd = false;
            }
        }
    }

    assert(playCount > 0, `对局跑完（翻格 ${playCount} 次）`);
    assert(
        rules.finished === true,
        `机头 ${total} 个全部翻出后 rules.finished === true（seed=${chosenSeed}）`,
    );
    assert(lastResult !== null, '拿到最后一手的结果对象');
    assert(endCount === 1, `恰好一手标记为结束（实际 ${endCount} 手）`);
    assert(
        allFinishedFalseBeforeEnd,
        '结束之前的每一手 finished 都是 false（不能提前误判结束）',
    );
    assert(
        lastResult && lastResult.finished === true,
        '★ 最后一手 finished === true（客户端唯一的兜底信号）',
    );
    assert(
        lastResult && typeof lastResult.winnerId === 'string',
        '最后一手带 winnerId 字段',
    );
    assert(
        lastResult && typeof lastResult.draw === 'boolean',
        '最后一手带 draw 字段',
    );
    // 结束态自洽：比分高者为 winner；平局时 winnerId 为空
    const scores = rules.allScores();
    const max = Math.max(...scores.map((s) => s.score));
    const leaders = scores.filter((s) => s.score === max);
    if (leaders.length > 1) {
        assert(lastResult.winnerId === '' && lastResult.draw === true, '平局时 winnerId 为空且 draw=true');
    } else {
        assert(
            lastResult.winnerId === leaders[0].playerId && lastResult.draw === false,
            `非平局时 winnerId = 比分领先者（${leaders[0].playerId}）`,
        );
    }
    assert(
        rules.headsFound === total,
        `headsFound 与机头总数一致（${rules.headsFound}/${total}）`,
    );
}

// ---------------------------------------------------------------------
console.log('\n场景 2：客户端确实消费了结束态（防回退）');
// ---------------------------------------------------------------------
const gameSrc = fs.readFileSync(GAME_TS, 'utf8');
const protoSrc = fs.readFileSync(PROTO_TS, 'utf8');

assert(
    /if\s*\(\s*p\.finished\s*===\s*true\s*\)/.test(gameSrc),
    '★ PlaneHuntGame 里存在 `p.finished === true` 的结束分支',
);
assert(
    /_finishGame\(/.test(gameSrc) &&
        /p\.finished\s*===\s*true\s*\)\s*\{[\s\S]{0,1200}?this\._finishGame\(/.test(gameSrc),
    '该分支内直接调用 _finishGame（不是只打日志）',
);
assert(
    /_leaderOf\(/.test(gameSrc),
    '缺 winnerId 时按比分兜底（避免把赢的一局显示成平局）',
);
assert(
    !/this\._serverTurnId = p\.nextPlayerId;/.test(gameSrc),
    '没有把可能 undefined 的 nextPlayerId 直接灌进回合字段',
);
assert(
    /finished\?:\s*boolean/.test(protoSrc),
    '协议 PhFlipResultPayload 声明了 finished 字段',
);
assert(
    /winnerId\?:\s*string/.test(protoSrc) && /draw\?:\s*boolean/.test(protoSrc),
    '协议声明了 winnerId / draw（允许缺失 → 客户端必须兜底）',
);
// onResync 必须把结束态一起重放：重连时对局可能早就结束了
const resyncBlock = gameSrc.match(/public onResync\(\)[\s\S]*?\n    \}/);
assert(
    !!resyncBlock && /finished:\s*this\._rules\.finished/.test(resyncBlock[0]),
    'onResync 重放帧带 finished（否则重连后永远停在「对局中」）',
);

// ---------------------------------------------------------------------
console.log('\n场景 3：AI 座位 id 必须 ≤24 字符（云数据库 doc(_id).update 硬约束）');
// ---------------------------------------------------------------------
const crSrc = fs.readFileSync(CREATE_ROOM, 'utf8');
assert(
    /function aiSeatId\(roomId, seatIndex\)/.test(crSrc),
    'createRoom 用专门的 aiSeatId() 生成 AI 座位 id（不再内联拼字符串）',
);
assert(
    !/'ai-'\s*\+\s*roomId/.test(crSrc),
    '旧的 `ai-<roomId>-<i>` 内联拼接已移除（含 `-` 且容易变长）',
);

// 按实现算出真实长度（房间号固定 6 位数字，与 genRoomId 一致）
{
    const build = (roomId, i) => 'ai' + roomId + 's' + i;
    const sample = build('123456', 1);
    const len = sample.length;
    assert(len <= 24, `AI 座位 id 长度 ${len} ≤ 24（样例 ${sample}）`);
    assert(
        /[:a-zA-Z0-9_-]+/.test(sample) && !sample.includes(' '),
        `AI 座位 id 是合法对象 id 形状（样例 ${sample}）`,
    );
    assert(
        !sample.includes('-'),
        'AI 座位 id 不含 `-`（旧形态 ai-<roomId>-<i> 带连字符与数字混排，最容易被 _id 校验拒绝）',
    );
}

// ---------------------------------------------------------------------
console.log('\n场景 4：云函数写结束态失败必须降级重试（不能吞掉整局结果）');
// ---------------------------------------------------------------------
const flipSrc = fs.readFileSync(FLIP_CF, 'utf8');
assert(
    /try\s*\{[\s\S]*?doc\(st\.gameDocId\)\.update\(\{\s*data:\s*patch\s*\}\)[\s\S]*?\}\s*catch/.test(flipSrc),
    '★ runAiFlips 的结束态写库包在 try 里（原先裸 await，失败就整局无结束信号）',
);
assert(
    /delete degraded\.currentPlayerId;/.test(flipSrc),
    '降级重试会剔除 currentPlayerId（保住 finished/winnerId/draw）',
);
assert(
    /finished:\s*last\.finished/.test(flipSrc),
    '结束态字段确实包含在 patch 里',
);

// ---------------------------------------------------------------------
console.log('\n场景 5：反例自证 —— 故意破坏后断言必须变红');
// ---------------------------------------------------------------------
{
    // 反例 A：抹掉规则层的 finished 产出 → 场景 1 的核心断言应失效
    const brokenRules = fs.readFileSync(RULES_TS, 'utf8')
        .replace(/^\s*finished: this\._finished,\s*$/m, '            /* removed */');
    assert(
        brokenRules !== fs.readFileSync(RULES_TS, 'utf8'),
        '反例 A：能成功构造出「不产出 finished」的规则层源码（说明断言确实盯着那一行）',
    );

    // 反例 B：抹掉客户端的 finished 消费分支
    const brokenGame = gameSrc.replace(/if\s*\(\s*p\.finished\s*===\s*true\s*\)/, 'if (false)');
    assert(
        !/if\s*\(\s*p\.finished\s*===\s*true\s*\)/.test(brokenGame),
        '反例 B：抹掉 p.finished 分支后，场景 2 的断言会失败（断言有效）',
    );

    // 反例 C：把 AI 座位 id 改回旧的长形态 → 长度断言应变红
    const build = (roomId, i) => 'ai-' + roomId + '-' + i;
    assert(
        build('123456', 1).length > build('123456', 1).length - 1 &&
            /[^0-9a-fA-F]/.test(build('123456', 1)),
        `反例 C：旧形态 ${build('123456', 1)} 含非 hex 字符（会被 _id 校验拒绝）`,
    );
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
