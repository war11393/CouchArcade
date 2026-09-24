/**
 * 部署脚本生成器 / 一键部署（开发辅助，不参与游戏运行）。
 *
 * ============================================================================
 * 为什么要有这个文件（2026-09-24 真机事故）
 * ============================================================================
 * 手工敲 CLI 部署云函数时漏了 `--remote-npm-install`，结果只上传了 4 个源码文件，
 * **云端没有安装 `wx-server-sdk`**，真机上一点棋盘就报：
 *     errCode: -504002 functions execute fail
 *     Error: Cannot find module 'wx-server-sdk'
 *
 * 更值得记的是**为什么没在部署时发现**：我用 `download` 把云端代码拉回来做了
 * 逐字节比对，源码完全一致 —— 于是判定「部署成功」。但「源码传对了」与
 * 「函数能跑」是两件事：少了依赖，源码再一致也照样 `-504002`。
 * 所以本脚本的职责是把**部署 + 依赖验证**合成一步，而不是只做上传。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *   node tools/deploy-cloudfunctions.js --list
 *       只打印将要执行的命令（不实际部署），用于人工核对。
 *
 *   node tools/deploy-cloudfunctions.js [函数名...]
 *       部署指定云函数（缺省=全部）。**始终带 --remote-npm-install**。
 *
 *   node tools/deploy-cloudfunctions.js --verify [函数名...]
 *       只做验证：把云端代码下载回来，检查 (a) 逐字节一致 (b) node_modules
 *       里确实有 wx-server-sdk。这是判定「部署真的生效」的唯一标准。
 *
 * 依赖：需要微信开发者工具已启动且**服务端口已开启**（工具 → 设置 → 安全设置）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CF_ROOT = path.join(ROOT, 'cloudfunctions');

const TOOLS_DIR = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具';
const CLI_JS = path.join(TOOLS_DIR, 'resources', 'app.asar.unpacked', 'js', 'common', 'cli', 'index.js');
const EXE = path.join(TOOLS_DIR, '微信开发者工具.exe');
const ENV_ID = 'cloud1-d7gp1em2efcf2b05b';
const PROJECT = 'C:/Users/war11/wechat_game';

/** 所有云函数名（cloudfunctions/ 下的目录，排除共享模块 common）。 */
function functionNames() {
    return fs
        .readdirSync(CF_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'common')
        .map((d) => d.name)
        .sort();
}

/**
 * 调用 DevTools CLI。
 *
 * 为什么要用这段绕路的 -e 引导脚本：cli.bat 在本机找不到 Electron 可执行文件
 * （`for %%F in (*.exe)` 匹配不到 `微信开发者工具.exe`），直接跑会报
 * "Cannot find Electron executable"。这里按 cli.bat 的原逻辑手工拼一次。
 */
function runCli(args) {
    const boot =
        'const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=="--electron"});' +
        'if(!process.env.cwd)process.env.cwd=process.cwd();' +
        'process.argv=[process.execPath,"--ms-enable-electron-run-as-node",e,"--electron"].concat(a);' +
        'require(e)';
    return execFileSync(EXE, ['-e', boot, CLI_JS, ...args], {
        cwd: TOOLS_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        timeout: 420000,
    });
}

/** 部署命令（务必带 --remote-npm-install）。 */
function deployArgs(names) {
    return [
        'cloud', 'functions', 'deploy',
        '--env', ENV_ID,
        '--names', ...names,
        // ⚠️ 这一行就是本次事故的修复点：没有它，云端不会 npm install，
        //    函数会在运行时抛 Cannot find module 'wx-server-sdk'。
        '--remote-npm-install',
        '--project', PROJECT,
        '--lang', 'zh',
    ];
}

function downloadArgs(name, dest) {
    return [
        'cloud', 'functions', 'download',
        '--env', ENV_ID, '--name', name, '--path', dest,
        '--project', PROJECT, '--lang', 'zh',
    ];
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const verifyOnly = args.includes('--verify');
const rest = args.filter((a) => !a.startsWith('--'));
const targets = rest.length ? rest : functionNames();

// 参数合法性：别把拼错的函数名当成「要部署的新函数」
const known = functionNames();
const unknown = targets.filter((t) => !known.includes(t));
if (unknown.length) {
    console.error(`未知云函数名：${unknown.join(', ')}\n可用：${known.join(', ')}`);
    process.exit(1);
}

if (listOnly) {
    console.log('将执行（仅打印，不实际部署）：\n');
    for (const n of targets) {
        console.log(`  # ${n}`);
        console.log(`  cli ${deployArgs([n]).join(' ')}\n`);
    }
    console.log(`共 ${targets.length} 个。注意 --remote-npm-install 必须在。`);
    process.exit(0);
}

if (!fs.existsSync(EXE) || !fs.existsSync(CLI_JS)) {
    console.error(`找不到微信开发者工具：\n  ${EXE}\n  ${CLI_JS}`);
    process.exit(1);
}

let failed = 0;

if (!verifyOnly) {
    console.log(`=== 部署 ${targets.length} 个云函数（含云端安装依赖）===`);
    for (const n of targets) {
        process.stdout.write(`▶ ${n} ... `);
        try {
            const out = runCli(deployArgs([n]));
            // 判定标准：输出里出现这一行才算成功；只看退出码会被 CLI 的
            // 「✖ 部署云函数 / 以 0 退出」组合骗过。
            if (/上传云函数 .* - 部署/.test(out) && /✔ (\[.*\] )?部署云函数/.test(out)) {
                console.log('成功');
            } else {
                failed++;
                console.log('失败');
                console.error(out.split('\n').slice(-14).map((l) => `    ${l}`).join('\n'));
            }
        } catch (err) {
            failed++;
            console.log('异常');
            console.error(String(err.stdout || err.message).split('\n').slice(-14).map((l) => `    ${l}`).join('\n'));
        }
    }
    console.log('');
}

if (verifyOnly || failed === 0) {
    console.log('=== 验证：下载云端代码，检查源码一致 + 依赖已安装 ===');
    const tmp = path.join(ROOT, 'temp', 'deploy-verify');
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const n of targets) {
        process.stdout.write(`▶ ${n} ... `);
        const dest = path.join(tmp, n);
        // ⚠️ 目标目录必须**预先存在**：DevTools CLI 的 download 不会创建目录，
        //    目录缺失时它会静默不落地文件（表现为之后读 index.js 报 ENOENT），
        //    而不是给出一条明确的错误 —— 这个坑在本工具第一版上踩到了。
        fs.mkdirSync(dest, { recursive: true });
        try {
            runCli(downloadArgs(n, dest.replace(/\\/g, '/')));
            const localIndex = fs.readFileSync(path.join(CF_ROOT, n, 'index.js'), 'utf8');
            const cloudIndex = fs.readFileSync(path.join(dest, 'index.js'), 'utf8');
            const sdk = path.join(dest, 'node_modules', 'wx-server-sdk', 'package.json');
            const okSrc = localIndex === cloudIndex;
            const okDep = fs.existsSync(sdk);
            if (okSrc && okDep) {
                const v = JSON.parse(fs.readFileSync(sdk, 'utf8')).version;
                console.log(`✅ 源码一致 + wx-server-sdk@${v}`);
            } else {
                failed++;
                console.log(`❌ ${okSrc ? '源码一致' : '源码**不一致**'} / ${okDep ? '依赖已装' : '**依赖缺失**（需 --remote-npm-install 重新部署）'}`);
            }
        } catch (err) {
            failed++;
            console.log('下载失败');
            console.error(String(err.stdout || err.message).split('\n').slice(-8).map((l) => `    ${l}`).join('\n'));
        }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'DEPLOY_OK' : 'DEPLOY_FAILURES=' + failed}`);
process.exit(failed === 0 ? 0 : 1);
