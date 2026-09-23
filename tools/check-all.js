/**
 * 全量自检入口（开发辅助脚本，不参与游戏运行）。
 *
 * 为什么要有这个文件：各校验散落在多个脚本里，容易「只跑了一个就以为全过了」。
 * 本轮事故就有这个成分 —— typecheck 绿了，但云函数信封的双重包装
 * 是 typecheck 完全看不见的（云函数是 JS，不在 TS 项目内）。
 * 一个入口把「客户端 + 云函数 + 场景」三层都跑到，缺一层就报错。
 *
 * 运行：node tools/check-all.js
 *
 * 覆盖：
 *   1. typecheck（TypeScript 客户端）
 *   2. test-core（游戏核心算法：五子棋 / 寻机头）
 *   3. test-auth-fallback（登录三级兜底，不卡加载页）
 *   4. test-cloud-envelope（云函数信封双重包装，含反例）
 *   5. test-cloud-ai-seat（AI 练习房「开局被拦」回归，含修复前反例）
 *   6. test-result-dialog（结算弹窗无灰蒙版 + 拦截层不变式）
 *   7. test-thinking-overlay（「对手思考中」遮罩：共用基类 + 挡点击 + UI_2D 层）
 *   8. test-portrait-guards（竖版自适应短屏护栏数值仿真）
 *   9. validate-scenes（场景结构 / 路径契约 / 设计令牌）
 *  10. 云函数 common.js 副本一致性
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/** 跨平台调用 node。 */
function node(script) {
    return execFileSync(process.execPath, [path.join(__dirname, script)], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

const steps = [
    {
        name: 'typecheck（TS 客户端）',
        run: () => {
            // Windows 下 typecheck.cmd 必须经 cmd /c 调用
            const cmd = process.platform === 'win32' ? 'cmd' : 'sh';
            const args = process.platform === 'win32' ? ['/c', 'typecheck.cmd'] : ['typecheck.cmd'];
            return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        },
    },
    { name: 'test-core（游戏核心算法）', run: () => node('test-core.js') },
    { name: 'test-auth-fallback（登录兜底）', run: () => node('test-auth-fallback.js') },
    { name: 'test-cloud-envelope（云函数信封）', run: () => node('test-cloud-envelope.js') },
    { name: 'test-cloud-ai-seat（AI 练习开局）', run: () => node('test-cloud-ai-seat.js') },
    { name: 'test-result-dialog（结算弹窗无蒙版）', run: () => node('test-result-dialog.js') },
    { name: 'test-thinking-overlay（对手思考中遮罩）', run: () => node('test-thinking-overlay.js') },
    { name: 'test-portrait-guards（竖版护栏仿真）', run: () => node('test-portrait-guards.js') },
    { name: 'validate-scenes（场景校验）', run: () => node('validate-scenes.js') },
    {
        name: '云函数 common.js 副本一致性',
        run: () => {
            const auth = path.join(ROOT, 'cloudfunctions', 'common', 'index.js');
            const authoritative = fs.readFileSync(auth, 'utf8');
            const dirs = fs
                .readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
                .filter((d) => d.isDirectory() && d.name !== 'common')
                .map((d) => d.name)
                .sort();

            const drifted = [];
            for (const d of dirs) {
                const p = path.join(ROOT, 'cloudfunctions', d, 'common.js');
                if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== authoritative) {
                    drifted.push(d);
                }
            }
            if (drifted.length) {
                throw new Error(
                    `以下云函数的 common.js 与权威源 cloudfunctions/common/index.js 不一致：` +
                        `${drifted.join(', ')}。微信云函数不支持跨目录 require，必须逐个同步。`,
                );
            }
            return `  ${dirs.length} 份副本与权威源一致（${dirs.join(', ')}）\n`;
        },
    },
];

console.log('============================================================');
console.log('全量自检');
console.log('============================================================\n');

let failed = 0;
for (const step of steps) {
    process.stdout.write(`▶ ${step.name} ... `);
    try {
        const out = step.run();
        console.log('通过');
        if (out && out.trim()) {
            console.log(out.trimEnd());
        }
    } catch (err) {
        failed++;
        console.log('失败');
        const stdout = err.stdout ? String(err.stdout) : '';
        const stderr = err.stderr ? String(err.stderr) : '';
        const detail = (stderr || stdout || err.message || '').trim();
        console.error(detail.split('\n').slice(0, 30).map((l) => `    ${l}`).join('\n'));
    }
    console.log('');
}

console.log('============================================================');
if (failed === 0) {
    console.log('全部自检通过 ✓');
    console.log('============================================================');
} else {
    console.error(`${failed} 个自检项失败 ✗`);
    console.error('============================================================');
}
process.exit(failed === 0 ? 0 : 1);
