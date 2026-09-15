/**
 * 核心算法自测（开发辅助脚本，不参与游戏运行）。
 *
 * 用途：在没有 Cocos 编辑器的情况下，用 Node.js 直接验证两款游戏的纯逻辑层
 * （规则 + AI + 布局生成）是否正确。这些模块不依赖 cc 引擎，因此可直接 require。
 *
 * 运行：node tools/test-core.js
 *
 * 覆盖：
 * 1. 五子棋：五连检测四方向、和棋、非法落子、AI 能封堵活三、AI 能取胜
 * 2. 寻机头：布局生成合法（5 架、不重叠、不越界、机头数正确）、
 *    翻格奖励机制、机头奖励连翻、得分判定
 */

const path = require('path');
const fs = require('fs');

// ---- 极简 TS→JS 剥离：仅用于测试纯逻辑文件（无类型注解的运行时构造） ----
// 这些模块是纯 TS，Node 无法直接 require，故用 TypeScript 编译器（编辑器内置）转译。
const TSC_DIR = 'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\resources\\app.asar.unpacked\\node_modules\\typescript';

function compileTs(relPath, extraStubs) {
    const ts = require(TSC_DIR);
    const file = path.resolve(__dirname, '..', relPath);
    const src = fs.readFileSync(file, 'utf8');

    // 收集所有 import 的标识符名，便于后面按名注入依赖
    const importedNames = [];
    const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
        m[1].split(',').forEach(function (part) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) {
                importedNames.push(name);
            }
        });
    }

    // 去掉 import 语句（测试时用注入的依赖替代），保留其余代码
    const stripped = src.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');

    const out = ts.transpileModule(stripped, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2017,
            module: ts.ModuleKind.CommonJS,
        },
    });
    const js = out.outputText;

    // 注入被剥离的依赖：显式传入的优先，其余按名到全局 deps 里找
    const stubs = extraStubs || {};
    const prelude = [];
    importedNames.forEach(function (name) {
        if (Object.prototype.hasOwnProperty.call(stubs, name)) {
            return; // 已显式提供
        }
        // 未显式提供 → 从 extraStubs 的任意命名空间对象里按名查找
        let found = null;
        Object.keys(stubs).forEach(function (ns) {
            const v = stubs[ns];
            if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, name)) {
                found = v[name];
            }
        });
        if (found !== null) {
            stubs[name] = found;
        } else {
            // 兜底：声明为 undefined，避免 ReferenceError 掩盖真实问题
            prelude.push('var ' + name + ' = undefined;');
        }
    });

    const stubCode = Object.keys(stubs)
        .map(function (k) {
            return 'const ' + k + ' = __deps__[' + JSON.stringify(k) + '];';
        })
        .join('\n');

    const module_ = { exports: {} };
    const fn = new Function('exports', 'module', '__deps__', stubCode + '\n' + prelude.join('\n') + '\n' + js);
    fn(module_.exports, module_, stubs);
    return module_.exports;
}

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
    if (cond) {
        pass++;
        console.log('  PASS  ' + name);
    } else {
        fail++;
        console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
    }
}

// =====================================================================
console.log('\n=== 五子棋规则 (GomokuRules) ===');
// =====================================================================

const AppConfigStub = {
    AppConfig: {
        GOMOKU_SIZE: 15,
        GOMOKU_WIN_COUNT: 5,
        PLANEHUNT_SIZE: 12,
        PLANEHUNT_PLANE_COUNT: 5,
        LOG_VERBOSE: false,
    },
    /** AiLevel 枚举（与 AppConfig.ts 同名导出保持一致）。 */
    AiLevel: { EASY: 1, NORMAL: 2, HARD: 3 },
};

const { GomokuRules } = compileTs('assets/scripts/games/gomoku/GomokuRules.ts', {
    AppConfig: AppConfigStub.AppConfig,
});

// 1) 水平五连
{
    const g = new GomokuRules('A', 'B');
    // A 在 (7,3..6) 落 4 子，B 在别处落子
    for (let i = 0; i < 4; i++) {
        g.applyMove(7, 3 + i, 'A');
        g.applyMove(0, i, 'B');
    }
    const ok = g.applyMove(7, 7, 'A');
    check('水平五连判定', ok && g.finished && g.winnerId === 'A', 'winner=' + g.winnerId);
    check('水平五连返回连线', g.winLine.length >= 5, 'line=' + g.winLine.length);
}

// 2) 垂直五连
{
    const g = new GomokuRules('A', 'B');
    for (let i = 0; i < 4; i++) {
        g.applyMove(2 + i, 5, 'A');
        g.applyMove(0, i, 'B');
    }
    g.applyMove(6, 5, 'A');
    check('垂直五连判定', g.finished && g.winnerId === 'A', 'winner=' + g.winnerId);
}

// 3) 主对角五连
{
    const g = new GomokuRules('A', 'B');
    for (let i = 0; i < 4; i++) {
        g.applyMove(3 + i, 3 + i, 'A');
        g.applyMove(0, i, 'B');
    }
    g.applyMove(7, 7, 'A');
    check('主对角五连判定', g.finished && g.winnerId === 'A', 'winner=' + g.winnerId);
}

// 4) 副对角五连
{
    const g = new GomokuRules('A', 'B');
    for (let i = 0; i < 4; i++) {
        g.applyMove(3 + i, 10 - i, 'A');
        g.applyMove(0, i, 'B');
    }
    g.applyMove(7, 6, 'A');
    check('副对角五连判定', g.finished && g.winnerId === 'A', 'winner=' + g.winnerId);
}

// 5) 四连不判胜
{
    const g = new GomokuRules('A', 'B');
    for (let i = 0; i < 3; i++) {
        g.applyMove(7, 3 + i, 'A');
        g.applyMove(0, i, 'B');
    }
    g.applyMove(7, 6, 'A');
    check('四连不判胜', !g.finished, 'finished=' + g.finished);
}

// 6) 非法落子：重复位置
{
    const g = new GomokuRules('A', 'B');
    g.applyMove(7, 7, 'A');
    const err = g.validateMove(7, 7, 'B');
    check('占用位置拒绝落子', err !== null, 'err=' + err);
}

// 7) 非法落子：越界
{
    const g = new GomokuRules('A', 'B');
    check('越界拒绝落子', g.validateMove(15, 0, 'A') !== null);
    check('负数拒绝落子', g.validateMove(-1, 0, 'A') !== null);
}

// 8) 非法落子：轮次错误
{
    const g = new GomokuRules('A', 'B');
    const err = g.validateMove(7, 7, 'B');
    check('非本方回合拒绝落子', err !== null, 'err=' + err);
}

// 9) 回合切换
{
    const g = new GomokuRules('A', 'B');
    g.applyMove(7, 7, 'A');
    check('落子后切换回合到 B', g.currentPlayerId === 'B', 'cur=' + g.currentPlayerId);
    g.applyMove(8, 8, 'B');
    check('再次切换到 A', g.currentPlayerId === 'A', 'cur=' + g.currentPlayerId);
}

// =====================================================================
console.log('\n=== 五子棋 AI (GomokuAi) ===');
// =====================================================================

const { GomokuAi } = compileTs('assets/scripts/games/gomoku/GomokuAi.ts', {
    AppConfig: AppConfigStub.AppConfig,
    AiLevel: AppConfigStub.AiLevel,
    GomokuRules: { BLACK: 1, WHITE: 2, GomokuRules: GomokuRules },
    BLACK: 1,
    WHITE: 2,
});

// 10) AI 必须封堵对方活四（否则必败）
{
    const g = new GomokuRules('A', 'B');
    // A 造活四 (7,4)(7,5)(7,6)(7,7)，两端 (7,3)/(7,8) 空
    // 先让 B 落一子，确保轮到 A；再让 A 走完 4 子，回到 B 的回合
    g.applyMove(0, 0, 'B');
    for (let i = 0; i < 4; i++) {
        g.applyMove(7, 4 + i, 'A');
        if (i < 3) {
            g.applyMove(0, 1 + i, 'B');
        }
    }
    // 现在轮到 B，AI(B) 应在 (7,3) 或 (7,8) 封堵
    const ai = new GomokuAi('B', 'A', 2);
    const d = ai.decide(g);
    const blocks = d && ((d.row === 7 && d.col === 3) || (d.row === 7 && d.col === 8));
    check(
        'AI 封堵活四',
        !!blocks,
        '当前回合=' + g.currentPlayerId + ' 决策=' + (d ? '(' + d.row + ',' + d.col + ')' : 'null'),
    );
}

// 11) AI 能抓住自己的胜点（活四时直接成五）
{
    const g = new GomokuRules('A', 'B');
    // B 造活四 (9,4)(9,5)(9,6)(9,7)；先让 A 落一子，确保轮到 B
    g.applyMove(0, 0, 'A');
    for (let i = 0; i < 4; i++) {
        g.applyMove(9, 4 + i, 'B');
        if (i < 3) {
            g.applyMove(0, 1 + i, 'A');
        }
    }
    // 现在轮到 B
    const ai = new GomokuAi('B', 'A', 2);
    const d = ai.decide(g);
    const wins = d && d.row === 9 && (d.col === 3 || d.col === 8);
    check(
        'AI 抓住成五胜点（不被防守分反超）',
        !!wins,
        '当前回合=' + g.currentPlayerId + ' 决策=' + (d ? '(' + d.row + ',' + d.col + ')' : 'null'),
    );
}

// 12) AI 首手落天元
{
    const g = new GomokuRules('A', 'B');
    const ai = new GomokuAi('A', 'A', 2);
    const d = ai.decide(g);
    check('AI 首手落天元(7,7)', d && d.row === 7 && d.col === 7, d ? '(' + d.row + ',' + d.col + ')' : 'null');
}

// 13) AI 决策必为合法空位
{
    const g = new GomokuRules('A', 'B');
    g.applyMove(7, 7, 'A');
    g.applyMove(7, 8, 'B');
    const ai = new GomokuAi('A', 'A', 2);
    const d = ai.decide(g);
    check('AI 决策落在空位', d && g.get(d.row, d.col) === 0, d ? '(' + d.row + ',' + d.col + ')' : 'null');
}

// =====================================================================
console.log('\n=== 寻机头布局 (PlaneHuntLayoutProvider) ===');
// =====================================================================

const layoutMod = compileTs('assets/scripts/games/planehunt/PlaneHuntLayout.ts', {
    AppConfig: AppConfigStub.AppConfig,
});
const { PlaneHuntLayoutProvider, Rng } = layoutMod;

// 14) Rng 确定性
{
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seq1 = [a.int(0, 100), a.int(0, 100), a.int(0, 100)];
    const seq2 = [b.int(0, 100), b.int(0, 100), b.int(0, 100)];
    check('同 seed 生成相同随机序列', JSON.stringify(seq1) === JSON.stringify(seq2), seq1 + ' vs ' + seq2);
}

// 15) 布局生成：多 seed 大量验证
{
    const provider = new PlaneHuntLayoutProvider();
    let okCount = 0;
    let overlapCount = 0;
    let boundCount = 0;
    let headCountBad = 0;
    let bodyCountBad = 0;
    const SEEDS = 200;
    for (let s = 1; s <= SEEDS; s++) {
        const layout = provider.generate(s * 7919);
        // 机头数量必须 = 5
        if (layout.heads.length !== 5) {
            headCountBad++;
        }
        // 机头总数应为 5
        let heads = 0;
        let bodies = 0;
        for (let r = 0; r < layout.size; r++) {
            for (let c = 0; c < layout.size; c++) {
                const v = layout.cells[r][c];
                if (v === 2) heads++;
                else if (v === 1) bodies++;
            }
        }
        if (heads !== 5) headCountBad++;
        // 机身数应在 0..45 之间，且总占格数 = 机身 + 机头 = 50
        if (bodies + heads !== 50) bodyCountBad++;
        // planeIndexAt 与 cells 一致性
        let mismatch = 0;
        for (let r = 0; r < layout.size; r++) {
            for (let c = 0; c < layout.size; c++) {
                const isPlane = layout.cells[r][c] !== 0;
                const hasIdx = layout.planeIndexAt[r][c] >= 0;
                if (isPlane !== hasIdx) mismatch++;
            }
        }
        if (mismatch === 0) okCount++;
        else overlapCount++;
        // 越界检查（generate 内部已保证，此处再验）
        if (layout.heads.some((h) => h.row < 0 || h.row >= layout.size || h.col < 0 || h.col >= layout.size)) {
            boundCount++;
        }
    }
    check(`布局生成 ${SEEDS} 次全部合法（cells/planeIndexAt 一致）`, okCount === SEEDS, 'ok=' + okCount);
    check(`布局机头数恒为 5`, headCountBad === 0, 'bad=' + headCountBad);
    check(`布局总占格数恒为 50（每架 1 机头 + 9 机身，共 5 架）`, bodyCountBad === 0, 'bad=' + bodyCountBad);
    check('机头坐标均在界内', boundCount === 0, 'bad=' + boundCount);
}

// 16) 布局不重叠（每架 10 格，5 架共 50 格，互不重叠）
{
    const provider = new PlaneHuntLayoutProvider();
    const layout = provider.generate(20240910);
    let planeCells = 0;
    for (let r = 0; r < layout.size; r++) {
        for (let c = 0; c < layout.size; c++) {
            if (layout.cells[r][c] !== 0) planeCells++;
        }
    }
    check('5 架飞机共占 50 格（无重叠）', planeCells === 50, 'cells=' + planeCells);
}

// 17) 同 seed 布局可复现
{
    const provider = new PlaneHuntLayoutProvider();
    const l1 = provider.generate(777);
    const l2 = provider.generate(777);
    check('同 seed 布局完全可复现', l1.fingerprint === l2.fingerprint, l1.fingerprint + ' vs ' + l2.fingerprint);
}

// =====================================================================
console.log('\n=== 寻机头规则 (PlaneHuntRules) ===');
// =====================================================================

const rulesMod = compileTs('assets/scripts/games/planehunt/PlaneHuntRules.ts', {
    AppConfig: AppConfigStub.AppConfig,
    CELL_EMPTY: 0,
    CELL_HEAD: 2,
    PlaneHuntLayoutProvider: PlaneHuntLayoutProvider,
    PlaneLayout: {},
});
const { PlaneHuntRules } = rulesMod;

// 18) 翻中机头 → 得分 + 额外一次
{
    const rules = new PlaneHuntRules('A', 'B', 12345);
    // 直接查权威机头位置来测试「翻中」路径
    const heads = rules.authoritativeHeads();
    check('权威布局含 5 个机头', heads.length === 5, 'heads=' + heads.length);

    const h0 = heads[0];
    const res = rules.applyFlip(h0.row, h0.col, 'A');
    check('翻中机头计分', res && res.scored === true, JSON.stringify(res));
    check('翻中机头得 1 分', rules.scoreOf('A') === 1, 'score=' + rules.scoreOf('A'));
    check('翻中机头奖励额外一次（回合不变）', res && res.extraTurn === true && rules.currentPlayerId === 'A', 'cur=' + rules.currentPlayerId);
}

// 19) 翻中机身 → 不得分 + 回合切换
{
    const rules = new PlaneHuntRules('A', 'B', 12345);
    const layout = rules.layout;
    // 找一个机身格
    let bodyCell = null;
    for (let r = 0; r < layout.size && !bodyCell; r++) {
        for (let c = 0; c < layout.size; c++) {
            if (layout.cells[r][c] === 1) {
                bodyCell = { row: r, col: c };
                break;
            }
        }
    }
    const res = rules.applyFlip(bodyCell.row, bodyCell.col, 'A');
    check('翻中机身不得分', res && res.scored === false, JSON.stringify(res));
    check('翻中机身切换回合到 B', rules.currentPlayerId === 'B', 'cur=' + rules.currentPlayerId);
}

// 20) 翻空格 → 无收获 + 回合切换
{
    const rules = new PlaneHuntRules('A', 'B', 12345);
    const layout = rules.layout;
    let emptyCell = null;
    for (let r = 0; r < layout.size && !emptyCell; r++) {
        for (let c = 0; c < layout.size; c++) {
            if (layout.cells[r][c] === 0) {
                emptyCell = { row: r, col: c };
                break;
            }
        }
    }
    const res = rules.applyFlip(emptyCell.row, emptyCell.col, 'A');
    check('翻空格无收获', res && res.scored === false && res.extraTurn === false, JSON.stringify(res));
    check('翻空格切换回合', rules.currentPlayerId === 'B', 'cur=' + rules.currentPlayerId);
}

// 21) 重复翻同一格被拒绝
{
    const rules = new PlaneHuntRules('A', 'B', 999);
    const heads = rules.authoritativeHeads();
    rules.applyFlip(heads[0].row, heads[0].col, 'A');
    const err = rules.validateFlip(heads[0].row, heads[0].col, 'A');
    check('重复翻格被拒绝', err !== null, 'err=' + err);
}

// 22) 非本方回合被拒绝
{
    const rules = new PlaneHuntRules('A', 'B', 999);
    const heads = rules.authoritativeHeads();
    // B 先手翻（应为 A 的回合）
    const err = rules.validateFlip(heads[0].row, heads[0].col, 'B');
    check('非本方回合翻格被拒绝', err !== null, 'err=' + err);
}

// 23) 翻完全部机头 → 结束 + 判定胜负
{
    const rules = new PlaneHuntRules('A', 'B', 4242);
    const heads = rules.authoritativeHeads();
    // A 翻 3 个机头（连续奖励），B 翻 2 个机头
    let i = 0;
    for (; i < 3; i++) {
        rules.applyFlip(heads[i].row, heads[i].col, 'A');
    }
    for (; i < 5; i++) {
        // 若因奖励机制仍是 A 的回合，则强制按当前回合玩家翻
        const cur = rules.currentPlayerId;
        rules.applyFlip(heads[i].row, heads[i].col, cur);
    }
    check('机头翻完对局结束', rules.finished === true, 'finished=' + rules.finished);
    check('得分高者获胜', rules.winnerId !== '' || rules.isDraw, 'winner=' + rules.winnerId + ' draw=' + rules.isDraw);
    check('机头计数为 5', rules.headsFound === 5, 'heads=' + rules.headsFound);
}

// =====================================================================
console.log('\n=== 寻机头 AI (PlaneHuntAi) ===');
// =====================================================================

const aiMod = compileTs('assets/scripts/games/planehunt/PlaneHuntAi.ts', {
    AppConfig: AppConfigStub.AppConfig,
    AiLevel: AppConfigStub.AiLevel,
    CELL_BODY: 1,
    PlaneHuntRules: PlaneHuntRules,
});
const { PlaneHuntAi } = aiMod;

// 24) AI 无信息时随机选未翻开格
{
    const rules = new PlaneHuntRules('A', 'B', 555);
    const ai = new PlaneHuntAi(2);
    const d = ai.decide(rules);
    check('AI 无信息时返回未翻开格', d && !rules.isRevealed(d.row, d.col), d ? '(' + d.row + ',' + d.col + ')' : 'null');
    check('AI 无信息时标记为 random', d && d.reason === 'random', d ? d.reason : 'null');
}

// 25) AI 发现机身后优先探索四邻域
{
    const rules = new PlaneHuntRules('A', 'B', 555);
    const layout = rules.layout;
    // 找机身格并翻开
    let bodyCell = null;
    for (let r = 0; r < layout.size && !bodyCell; r++) {
        for (let c = 0; c < layout.size; c++) {
            if (layout.cells[r][c] === 1) {
                bodyCell = { row: r, col: c };
                break;
            }
        }
    }
    rules.applyFlip(bodyCell.row, bodyCell.col, 'A');
    const ai = new PlaneHuntAi(2);
    const d = ai.decide(rules);
    // AI 的决策应落在该机身的四邻域（且未翻开）
    const isNeighbor =
        d &&
        Math.abs(d.row - bodyCell.row) + Math.abs(d.col - bodyCell.col) === 1 &&
        !rules.isRevealed(d.row, d.col);
    check('AI 发现机身后探索四邻域', !!isNeighbor, d ? '(' + d.row + ',' + d.col + ') reason=' + d.reason : 'null');
}

// 26) AI 决策始终合法（不会选已翻开格）— 多次采样
{
    const rules = new PlaneHuntRules('A', 'B', 8888);
    const ai = new PlaneHuntAi(2);
    let bad = 0;
    // 随机翻 30 格以产生信息
    for (let k = 0; k < 30; k++) {
        const cur = rules.currentPlayerId;
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
            const d = ai.decide(rules);
            if (!d) break;
            if (!rules.isRevealed(d.row, d.col)) {
                rules.applyFlip(d.row, d.col, cur);
                placed = true;
            } else {
                bad++;
                break;
            }
        }
        if (rules.finished) break;
    }
    check('AI 决策均为未翻开格', bad === 0, 'bad=' + bad);
}

// =====================================================================
console.log('\n===============================');
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log('===============================\n');

process.exit(fail === 0 ? 0 : 1);
