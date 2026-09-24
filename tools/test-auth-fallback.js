/**
 * 登录降级链路自测（开发辅助脚本，不参与游戏运行）。
 *
 * 用途：验证「云端登录失败时，用户不会卡死在加载页」这条**故障路径**。
 * 这是纯逻辑层测试 —— WxAuthService 只依赖注入的 ICloudService / IStorageService，
 * 不依赖 cc 引擎，因此可用 Node 直接跑（真机 jsbridge 环境无法在 CI 复现）。
 *
 * 运行：node tools/test-auth-fallback.js
 *
 * 覆盖的正是 docs/FIX_LOADING_STUCK.md 里那两个 bug + 后续演进：
 *   1. 云函数失败 + 无缓存  → 旧实现 throw（→ 卡加载页）；新实现返回本地会话
 *   2. 已降级的本地会话     → **每次仍重试云端**（偶发失败不可永久化，2026-09-24
 *      修正；此前"不再调用"的旧契约导致真机座位匹配死循环），失败时复用同一 id，
 *      云端恢复则自动升级真 openid
 *   3. 云端 openid 有缓存   → 优先用缓存（网络抖动不影响开局）
 *   4. 降级 id 的设备内稳定性 + local_ 前缀可辨识性
 *   5. updateProfile 在本地会话下仍能正常返回（不因降级而崩）
 *   7. adoptServerIdentity：建房后用服务端 ownerId 纠正降级会话（真/假/无效三态）
 */

const path = require('path');
const fs = require('fs');

const TSC_DIR =
    'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\resources\\app.asar.unpacked\\node_modules\\typescript';

function compileTs(relPath, extraStubs) {
    const ts = require(TSC_DIR);
    const file = path.resolve(__dirname, '..', relPath);
    const src = fs.readFileSync(file, 'utf8');

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

    const stripped = src.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');

    const out = ts.transpileModule(stripped, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2017,
            module: ts.ModuleKind.CommonJS,
        },
    });
    const js = out.outputText;

    const stubs = extraStubs || {};
    const prelude = [];
    importedNames.forEach(function (name) {
        if (Object.prototype.hasOwnProperty.call(stubs, name)) {
            return;
        }
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

// ---- 依赖桩：复刻真实 CloudError / errText / STORAGE_KEYS 的形状 ----
class CloudError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const CloudErrorsStub = {
    CloudError,
    errText: (code) => '错误码' + code,
};

const CollectionsStub = {
    STORAGE_KEYS: { USER_INFO: 'coucharcade_user_info' },
};

/** 内存存储桩（对应 IStorageService 的 get/set）。 */
function makeStorage(initial) {
    const map = Object.assign({}, initial || {});
    return {
        _map: map,
        get(k) {
            return map[k];
        },
        set(k, v) {
            map[k] = v;
        },
    };
}

/** 云服务桩：可按需模拟成功 / 抛 CloudError（即真机 code=9003 现场）。
 *  failTimes=N 时前 N 次失败、之后成功（模拟云端「偶发失败后恢复」）。 */
function makeCloud(mode, calls, failTimes) {
    return {
        callFunction(name, data) {
            calls.push({ name, data });
            const shouldFail =
                mode === 'fail' || (mode === 'flaky' && calls.length <= (failTimes || 1));
            if (!shouldFail) {
                return Promise.resolve({
                    openid: 'oRealOpenidFromCloud',
                    nickname: '云端昵称',
                    avatarUrl: 'https://example.com/a.png',
                });
            }
            // 7001 / 9003 都走这条：模拟云函数未部署/返回异常
            return Promise.reject(new CloudError(9003, '[WxAuth] login 返回缺少 openid'));
        },
        init() {},
    };
}

const { WxAuthService } = compileTs('assets/scripts/core/services/wx/WxAuthService.ts', {
    STORAGE_KEYS: CollectionsStub.STORAGE_KEYS,
    CloudError: CloudErrorsStub.CloudError,
    errText: CloudErrorsStub.errText,
});

// wx.login 桩：真机里 code 每次冷启动稳定，这里也返回固定值以便验证 id 稳定性。
global.wx = {
    login(opts) {
        opts.success({ code: 'stable-device-code-abc123' });
    },
};

// =====================================================================
// 主流程（包在 async 里：本文件是 CommonJS，不能用顶层 await）
// =====================================================================
async function main() {
    // =====================================================================
    console.log('\n=== 场景 1：云函数失败 + 无缓存（旧实现必卡加载页） ===');
    // =====================================================================
    {
        const calls = [];
        const svc = new WxAuthService(makeCloud('fail', calls), makeStorage());

        let threw = null;
        let user = null;
        try {
            user = await svc.login();
        } catch (e) {
            threw = e;
        }

        check('login() 不抛错（旧实现 throw → 卡死加载页）', threw === null, threw && threw.message);
        check('返回了可用的 UserInfo', !!user && !!user.openid);
        check('openid 带 local_ 前缀（一眼可辨非云端身份）', !!user && user.openid.indexOf('local_') === 0);
        check('昵称有兜底（不会出现 undefined）', !!user && !!user.nickname, user && user.nickname);
        check('确实尝试过云函数（不是静默跳过）', calls.length === 1, 'calls=' + calls.length);
        check('降级结果已写回缓存', !!svc.getCachedUser());
    }

    // =====================================================================
    console.log('\n=== 场景 2：本地会话设备内稳定 + 云端恢复后自动升级 ===');
    // 契约变更（2026-09-24 真机「座位信息异常」死循环后）：
    //   旧断言是「已降级 → 第二次不再调云函数」（省启动延迟）。
    //   但偶发失败会被永久钉进缓存：之后 createRoom 都能成功、唯独身份永远
    //   是 local_，GameScene 匹配不到服务端座位 → 无限被弹回大厅。
    //   新契约：每次 login 都重试云端；失败复用同一 local_ id；成功则升级。
    {
        const calls = [];
        const storage = makeStorage();
        const svc1 = new WxAuthService(makeCloud('fail', calls), storage);
        const first = await svc1.login();
        const callsAfterFirst = calls.length;

        // 模拟冷启动：同一份 storage，新的 service 实例，云端仍然失败
        const svc2 = new WxAuthService(makeCloud('fail', calls), storage);
        const second = await svc2.login();

        check('第二次 login **会**再调云函数（偶发失败不可永久化）',
            calls.length === callsAfterFirst + 1, 'calls=' + calls.length);
        check('第二次拿到同一个本地会话（设备内身份稳定）', first.openid === second.openid);

        // 模拟云端恢复：直接成功（flaky 桩有 `failTimes||1` 的 0 值陷阱，
        // 这里语义就是「云端好了」，用 ok 最干净）→ 本地会话必须升级
        const calls3 = [];
        const svc3 = new WxAuthService(makeCloud('ok', calls3), storage);
        const third = await svc3.login();
        check('云端恢复后自动升级成真 openid',
            third.openid === 'oRealOpenidFromCloud', third.openid);
        check('升级后的会话写回缓存',
            storage.get('coucharcade_user_info').openid === 'oRealOpenidFromCloud');
    }

    // =====================================================================
    console.log('\n=== 场景 3：云端 openid 有缓存时优先用缓存 ===');
    // =====================================================================
    {
        const calls = [];
        const storage = makeStorage({
            coucharcade_user_info: {
                openid: 'oRealOpenidCached',
                nickname: '老用户',
                avatarUrl: '',
            },
        });
        const svc = new WxAuthService(makeCloud('fail', calls), storage);
        const user = await svc.login();

        check('未抛错', !!user);
        check('沿用缓存的云端 openid（而非降级成 local_）', user.openid === 'oRealOpenidCached', user.openid);
        check('未写入 local_ 前缀', user.openid.indexOf('local_') !== 0);
    }

    // =====================================================================
    console.log('\n=== 场景 4：云函数正常时走真实链路（降级不误伤） ===');
    // =====================================================================
    {
        const calls = [];
        const svc = new WxAuthService(makeCloud('ok', calls), makeStorage());
        const user = await svc.login();

        check('拿到云端 openid', user.openid === 'oRealOpenidFromCloud', user.openid);
        check('拿到云端昵称', user.nickname === '云端昵称', user.nickname);
        check('没有 local_ 前缀', user.openid.indexOf('local_') !== 0);
        check('结果已缓存', svc.getCachedUser().openid === 'oRealOpenidFromCloud');
    }

    // =====================================================================
    console.log('\n=== 场景 5：wx.login 不可用时退化随机 id（仍不卡死） ===');
    // =====================================================================
    {
        const savedWx = global.wx;
        global.wx = undefined;
        try {
            const calls = [];
            const svc = new WxAuthService(makeCloud('fail', calls), makeStorage());
            let threw = null;
            let user = null;
            try {
                user = await svc.login();
            } catch (e) {
                threw = e;
            }
            check('wx 缺失时 login() 仍不抛错', threw === null, threw && threw.message);
            check('仍产出 local_ 会话', !!user && user.openid.indexOf('local_') === 0, user && user.openid);
        } finally {
            global.wx = savedWx;
        }
    }

    // =====================================================================
    console.log('\n=== 场景 6：降级后 updateProfile 不崩（本地会话路径） ===');
    // =====================================================================
    {
        // 云函数整体失败 → updateProfile 会抛，但必须是 CloudError 而非 TypeError
        const calls = [];
        const svc = new WxAuthService(makeCloud('fail', calls), makeStorage());
        await svc.login();

        let err = null;
        try {
            await svc.updateProfile('新昵称', 'https://example.com/n.png');
        } catch (e) {
            err = e;
        }
        check('updateProfile 抛的是 CloudError（可被上层识别并提示）', err instanceof CloudError, err && err.message);
    }

    // =====================================================================
    console.log('\n=== 场景 7：adoptServerIdentity —— 建房后用服务端 ownerId 纠正降级会话 ===');
    // （2026-09-24 真机：login 偶发失败降级 local_ 后，createRoom 成功 ——
    //   响应 ownerId 即服务端认定的我。若不在这里纠正，GameScene
    //   「座位信息异常」死循环就无解。）
    {
        // ① 降级态被纠正
        const storage = makeStorage();
        const svc = new WxAuthService(makeCloud('fail', []), storage);
        const local = await svc.login();
        check('前置：会话已降级 local_', local.openid.indexOf('local_') === 0, local.openid);
        svc.adoptServerIdentity('oServerOwnerXyz');
        check('adopt 后升级为服务端 openid',
            svc.getCachedUser().openid === 'oServerOwnerXyz', svc.getCachedUser().openid);
        check('昵称保留本地值（只纠正身份不覆盖资料）',
            !!svc.getCachedUser().nickname && svc.getCachedUser().nickname === local.nickname,
            svc.getCachedUser().nickname);
        check('纠正结果写回缓存',
            storage.get('coucharcade_user_info').openid === 'oServerOwnerXyz');

        // ② 真会话拒绝被覆盖（防误用）
        const svc2 = new WxAuthService(makeCloud('ok', []), makeStorage());
        await svc2.login(); // 真 openid
        svc2.adoptServerIdentity('oEvilAnother');
        check('真 openid 会话不被 adopt 覆盖',
            svc2.getCachedUser().openid === 'oRealOpenidFromCloud', svc2.getCachedUser().openid);

        // ③ 传入无效值不动作
        const storage3 = makeStorage();
        const svc3 = new WxAuthService(makeCloud('fail', []), storage3);
        const l3 = await svc3.login();
        svc3.adoptServerIdentity('');
        check('空字符串 → 保持本地会话', svc3.getCachedUser().openid === l3.openid);
        svc3.adoptServerIdentity('local_another_one');
        check('传入另一个 local_ → 不纠正（那是客户端自造 id，无权威可言）',
            svc3.getCachedUser().openid === l3.openid);
    }

    // =====================================================================
    console.log('\n===============================');
    console.log(`结果: ${pass} 通过, ${fail} 失败`);
    console.log('===============================\n');

    process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.error('测试脚本自身异常:', e);
    process.exit(1);
});
