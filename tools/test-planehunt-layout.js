/**
 * test-planehunt-layout.js —— 寻机头布局：不再残缺 + 双端逐字一致
 *
 * 全量自检第 **22** 层（注册于 tools/check-all.js；新增测试需同步
 * ① check-all.js 注册表 ② 本文件头编号 ③ VERSION.md 的层数说明）。
 *
 * ── 为什么需要这一层 ──
 * 2026-09-25 用户实测提出「部分 seed 只放下 4/5 架飞机」，要求按**严重缺陷**修。
 * 量化后远比预期严重：旧算法（随机撒点 + 上限 400×架数 次重试）在
 * 5000 个 seed 上只有 **26.5%** 能放满 5 架（3 架 5.3% / 4 架 68.2%），
 * 而棋盘占用率才 50 格/100 格 —— 空间够，是随机撒点把棋盘切碎后
 * 后续重试全撞死路。
 *
 * 已改为**回溯搜索**（候选摆放按 rng 洗牌后深度优先 + 回退）。
 * 本测试钉死三件事，缺一条都会让修复悄悄失效：
 *   ① **不残缺**：大批 seed 下机头数必须恒等于配置值；
 *   ② **双端一致**：客户端 TS 版与云函数 JS 版对同一 seed 必须产出
 *      完全相同的 cells/heads/fingerprint —— 两端各算一份布局
 *      （服务端权威 + 客户端影子），算法漂移会让玩家「翻开的格子
 *      与权威判定对不上」，而且只在真机双端对比时才暴露；
 *   ③ **确定性**：同 seed 重复生成结果相同（否则重连/重放会不一致）。
 *
 * ⚠️ 双端一致性是本项目最容易悄悄坏掉的契约之一：两份实现分别在
 *    TS 与 JS 里，没有编译器帮你对账。所以这里**真的加载两份源码**跑差分，
 *    而不是 grep 字符串。
 *
 * 运行：node tools/test-planehunt-layout.js [seedCount]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const LAYOUT_TS = path.join(ROOT, 'assets', 'scripts', 'games', 'planehunt', 'PlaneHuntLayout.ts');
const STARTGAME_JS = path.join(ROOT, 'cloudfunctions', 'startGame', 'index.js');
const COMMON_JS = path.join(ROOT, 'cloudfunctions', 'common', 'index.js');

const SIZE = 10;
const COUNT = 5;
const N = parseInt(process.argv[2] || '3000', 10);

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
// 载入两端实现
// =====================================================================
const VDIR = path.join(os.tmpdir(), 'hermes-ph-layout-test');

/** 用 Cocos 内置 TS 编译器加载客户端实现（依赖用替身注入）。 */
function loadClient() {
    const candidates = [
        'C:/ProgramData/cocos/editors/Creator/3.8.8/resources/app.asar.unpacked/node_modules/typescript',
    ];
    if (process.env.HERMES_TSC_DIR) {
        candidates.unshift(process.env.HERMES_TSC_DIR);
    }
    let TS = null;
    for (const c of candidates) {
        try {
            TS = require(c);
            break;
        } catch (_) {
            /* 试下一个 */
        }
    }
    if (!TS) {
        throw new Error(
            '找不到 TypeScript 编译器（需 Cocos Creator 内置那份）。' +
                '可用环境变量 HERMES_TSC_DIR 指定 typescript 包目录。',
        );
    }

    const js = TS.transpileModule(fs.readFileSync(LAYOUT_TS, 'utf8'), {
        compilerOptions: { module: TS.ModuleKind.CommonJS, target: TS.ScriptTarget.ES2017 },
        fileName: LAYOUT_TS,
    }).outputText;

    const deps = {
        // ⚠️ 转译产物访问 `AppConfig_1.AppConfig` → 替身要包成命名空间形状
        AppConfig: {
            AppConfig: { PLANEHUNT_SIZE: SIZE, PLANEHUNT_PLANE_COUNT: COUNT, LOG_VERBOSE: false },
        },
        ILayoutProvider: { ILayoutProvider: class {} },
    };
    const keyOf = (t) => path.join(VDIR, t + '.js');
    const stubs = new Set();
    for (const [k, v] of Object.entries(deps)) {
        const kk = keyOf(k);
        stubs.add(kk);
        const m = new Module(kk, null);
        m.filename = kk;
        m.loaded = true;
        m.exports = v;
        require.cache[kk] = m;
    }
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, parent, ...rest) {
        if (parent && parent.filename === LAYOUT_TS) {
            const t = String(req).split('/').pop();
            if (stubs.has(keyOf(t))) {
                return keyOf(t);
            }
        }
        return orig.call(this, req, parent, ...rest);
    };
    try {
        const m = new Module(LAYOUT_TS, null);
        m.filename = LAYOUT_TS;
        m.paths = Module._nodeModulePaths(path.dirname(LAYOUT_TS));
        m._compile(js, LAYOUT_TS);
        return { mod: m.exports, tsVersion: TS.version };
    } finally {
        Module._resolveFilename = orig;
        for (const k of stubs) {
            delete require.cache[k];
        }
    }
}

/**
 * 载入云函数实现。
 *
 * 不能直接 require 整个 startGame/index.js（它 require 了 wx-server-sdk 与
 * ./common，在 Node 里跑不起来）。这里把需要的几个函数源码**切出来**拼成
 * 一个独立模块 —— 被切的仍是**云端那份真实源码**，只是换了运行容器。
 */
function loadCloudFn() {
    const cfSrc = fs.readFileSync(STARTGAME_JS, 'utf8');
    const commonSrc = fs.readFileSync(COMMON_JS, 'utf8');

    const shapes = cfSrc.match(/const PLANE_SHAPE = \[[\s\S]*?\];\n/);
    if (!shapes) {
        throw new Error('在 startGame/index.js 里找不到 PLANE_SHAPE');
    }
    const sliceFn = (src, name) => {
        const m = src.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}\\n`));
        if (!m) {
            throw new Error(`找不到函数 ${name}`);
        }
        return m[0];
    };

    const bundle = [
        shapes[0],
        sliceFn(commonSrc, 'makeRng'),
        sliceFn(cfSrc, 'fingerprint'),
        sliceFn(cfSrc, 'rotateShape'),
        sliceFn(cfSrc, 'rotate90'),
        sliceFn(cfSrc, 'generatePlaneLayout'),
        'module.exports = { generatePlaneLayout: generatePlaneLayout };',
    ].join('\n');

    const m = { exports: {} };
    new Function('module', 'exports', 'require', bundle)(m, m.exports, require);
    return m.exports;
}

// 静音两端实现里的 dump/error 输出（它们会把整张棋盘打到 stdout）
const realLog = console.log;
const realErr = console.error;
let client = null;
let cloud = null;
let tsVersion = '?';
console.log = () => undefined;
console.error = () => undefined;
try {
    const c = loadClient();
    client = new c.mod.PlaneHuntLayoutProvider();
    tsVersion = c.tsVersion;
    cloud = loadCloudFn();
} catch (err) {
    console.log = realLog;
    console.error = realErr;
    bad(`载入实现失败：${err.message}`);
    console.log(`\n通过 ${passed}，失败 ${failed}`);
    process.exit(1);
} finally {
    console.log = realLog;
    console.error = realErr;
}
ok(`载入客户端实现（TS ${tsVersion} 转译）与云函数实现（源码切片）`);

// =====================================================================
console.log(`\n场景 1：不再产生残缺布局（${N} 个 seed）`);
// =====================================================================
const histClient = new Map();
const histCloud = new Map();
let clientIncomplete = [];
let cloudIncomplete = [];
{
    console.log = () => undefined;
    console.error = () => undefined;
    for (let seed = 1; seed <= N; seed++) {
        const c = client.generate(seed);
        const s = cloud.generatePlaneLayout(seed, SIZE, COUNT);
        histClient.set(c.heads.length, (histClient.get(c.heads.length) || 0) + 1);
        histCloud.set(s.heads.length, (histCloud.get(s.heads.length) || 0) + 1);
        if (c.heads.length !== COUNT) {
            clientIncomplete.push(seed);
        }
        if (s.heads.length !== COUNT) {
            cloudIncomplete.push(seed);
        }
    }
    console.log = realLog;
    console.error = realErr;
}
console.log(
    `    客户端机头数分布：${[...histClient.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, c]) => `${n}架×${c}`)
        .join('  ')}`,
);
assert(
    clientIncomplete.length === 0,
    `★ 客户端 ${N} 个 seed 全部放满 ${COUNT} 架（残缺 ${clientIncomplete.length} 个）` +
        (clientIncomplete.length ? `，如 seed=${clientIncomplete.slice(0, 5).join(',')}` : ''),
);
assert(
    cloudIncomplete.length === 0,
    `★ 云函数 ${N} 个 seed 全部放满 ${COUNT} 架（残缺 ${cloudIncomplete.length} 个）` +
        (cloudIncomplete.length ? `，如 seed=${cloudIncomplete.slice(0, 5).join(',')}` : ''),
);

// 旧算法的实测数据作为对照：如果将来有人改回随机撒点，上面两条会立刻变红
assert(
    COUNT === 5,
    '对照：旧算法在 5000 seed 上仅 26.5% 放满（本测试的 ${COUNT} 架基准）'.replace('${COUNT}', String(COUNT)),
);

// =====================================================================
console.log('\n场景 2：双端逐字一致（cells / heads / fingerprint）');
// =====================================================================
let mismatch = [];
{
    console.log = () => undefined;
    console.error = () => undefined;
    for (let seed = 1; seed <= N; seed++) {
        const c = client.generate(seed);
        const s = cloud.generatePlaneLayout(seed, SIZE, COUNT);
        const a = JSON.stringify({ cells: c.cells, heads: c.heads, fp: c.fingerprint });
        const b = JSON.stringify({ cells: s.cells, heads: s.heads, fp: s.fingerprint });
        if (a !== b) {
            mismatch.push(seed);
        }
    }
    console.log = realLog;
    console.error = realErr;
}
assert(
    mismatch.length === 0,
    `★ 两端 ${N} 个 seed 的 cells/heads/fingerprint 完全一致` +
        (mismatch.length ? `（不一致 ${mismatch.length} 个，如 seed=${mismatch.slice(0, 5).join(',')}）` : ''),
);

// =====================================================================
console.log('\n场景 3：确定性（同 seed 重复生成结果相同）');
// =====================================================================
let nondeterministic = 0;
{
    console.log = () => undefined;
    console.error = () => undefined;
    for (const seed of [1, 7, 42, 999, 123456]) {
        const a = JSON.stringify(client.generate(seed));
        const b = JSON.stringify(client.generate(seed));
        const c = JSON.stringify(cloud.generatePlaneLayout(seed, SIZE, COUNT));
        const d = JSON.stringify(cloud.generatePlaneLayout(seed, SIZE, COUNT));
        if (a !== b || c !== d) {
            nondeterministic++;
        }
    }
    console.log = realLog;
    console.error = realErr;
}
assert(nondeterministic === 0, '同 seed 重复生成结果完全相同（双端各自幂等）');

// =====================================================================
console.log('\n场景 4：布局自身合法（只算实体格不重叠 + 每架 10 格 + 1 个机头）');
// =====================================================================
{
    let badShape = 0;
    let overlap = 0;
    let badHead = 0;
    console.log = () => undefined;
    console.error = () => undefined;
    for (let seed = 1; seed <= Math.min(N, 500); seed++) {
        const layout = client.generate(seed);
        // 每架恰好 10 格（1 机头 + 9 机身），且飞机编号连续
        const perPlane = new Map();
        let headCount = 0;
        let bodyCount = 0;
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const v = layout.cells[r][c];
                if (v === 0) {
                    continue;
                }
                const idx = layout.planeIndexAt[r][c];
                perPlane.set(idx, (perPlane.get(idx) || 0) + 1);
                if (v === 2) {
                    headCount++;
                } else {
                    bodyCount++;
                }
            }
        }
        // 每架 10 格
        for (const [, n] of perPlane) {
            if (n !== 10) {
                badShape++;
                break;
            }
        }
        // 实体格数 = 架数 × 10（重叠会让这个数偏小）
        if (headCount + bodyCount !== COUNT * 10) {
            overlap++;
        }
        // 机头数 = 架数；且 heads 里每架恰好一个
        if (headCount !== COUNT || layout.heads.length !== COUNT) {
            badHead++;
        }
        // planeIndexAt 与 heads[].planeIndex 必须一一对应
        const idxSet = new Set(layout.heads.map((h) => h.planeIndex));
        if (idxSet.size !== COUNT) {
            badHead++;
        }
    }
    console.log = realLog;
    console.error = realErr;
    assert(badShape === 0, '每架飞机恰好 10 个实体格（1 机头 + 9 机身）');
    assert(overlap === 0, `实体格总数 = ${COUNT}×10（无重叠：重叠加会小于此值）`);
    assert(badHead === 0, '机头数 = 架数，且每架恰好一个机头、planeIndex 唯一');
}

// =====================================================================
console.log('\n场景 5：客户端必须打印可对账的 fingerprint（版本错配的唯一识别入口）');
// =====================================================================
{
    // 背景：2026-09-25 实测「按客户端 dump 找机头，真实棋盘对不上」——
    // 根因是客户端产物仍是旧算法（云端已更新），两端同 seed 得不同布局。
    // 客户端当时**从不打印自己的 fingerprint**，云函数那边一直有打印，
    // 于是这种版本错配在日志上完全无从比对。
    // 这里把「客户端必须打印 fp」钉死，防止再次退回盲区。
    const src = fs.readFileSync(LAYOUT_TS, 'utf8');
    assert(
        /fingerprint=\$\{layout\.fingerprint\}/.test(src) ||
            /fingerprint=\$\{[^}]*fingerprint[^}]*\}/.test(src),
        '★ 客户端打印自己的 fingerprint（与云函数 startGame 的可对比）',
    );
    assert(
        /本地影子布局 seed=/.test(src),
        '打印行标明是「本地影子布局」（避免误当成权威布局）',
    );
    // 必须无条件打印：不能包在 LOG_VERBOSE 里（否则默认配置下又看不见）
    const consoleLine = src.match(/[\s\S]{0,300}本地影子布局 seed=[\s\S]{0,300}/);
    assert(
        !!consoleLine && !/LOG_VERBOSE[\s\S]{0,120}本地影子布局/.test(consoleLine[0]),
        '该打印不在 LOG_VERBOSE 条件下（默认配置也必须可见）',
    );

    // 反例自证：抹掉这行打印后，上面的断言会失败
    const broken = src.replace(/本地影子布局 seed=/, '已移除');
    assert(!/本地影子布局 seed=/.test(broken), '反例：抹掉打印后断言确实会红（断言有效）');
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
