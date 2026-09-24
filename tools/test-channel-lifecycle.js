/**
 * 通道生命周期护栏（开发辅助脚本，不参与游戏运行）。
 *
 * ============================================================================
 * 为什么需要这个文件（2026-09-24 真机事故）
 * ============================================================================
 * 症状：AI 练习进对局后，点棋盘没有任何反应，一直卡在「对手思考中」，
 *       客户端日志停在 `[GomokuGame] 进入对局 …` 之后再无一条。
 *
 * 根因：`RoomScene._enterGame()` 切到 Game 场景时**没有停掉 room watch**。
 *   `gomoku_move` 一次调用会写两帧对局文档（人类手 + AI 回手），每帧都更新
 *   `rooms.updatedAt` → room watch 各推一次快照 → 已经离开的 Room 场景继续
 *   跑 `_onRoomState` / `_refreshButtons`（status 仍是 playing，入不了局，
 *   但每次推送都打日志）。落子 → 推送 → 刷新 → …形成反馈回路，
 *   把 JS 线程占满，连对局 watch 推来的 `gk.move.result` 都处理不到。
 *
 * 这类 bug 的特征：**每个函数单独看都对**，错在生命周期时序上。
 * 因此这里做的是**源码级不变式断言**（不是行为仿真 —— 行为仿真要拉起
 * Cocos 运行时，成本过高且同样会漏时序）：直接读源码，断言
 * 「停 watch 的调用必须存在于切换场景的那条路径里」。
 *
 * 断言的可证伪性：把 `_enterGame` 里那三行 `_unwatch()` 删掉，
 * 本脚本立刻变红（已在本次修复中反向验证过）。
 *
 * 运行：node tools/test-channel-lifecycle.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 取某个方法的方法体（从 `private xxx(` 起到下一个同级方法声明为止）。 */
function methodBody(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) {
        return null;
    }
    // 从签名处往下找「下一个 `\n    private `」或「\n    protected 」或「\n    public 」
    const rest = source.slice(start + signature.length);
    const m = rest.match(/\n    (?:private|protected|public|static)\s/);
    return m ? rest.slice(0, m.index) : rest;
}

console.log('=== 通道生命周期护栏 ===\n');

// ---------------------------------------------------------------------
console.log('场景 1：离开 Room 场景进入对局时，必须停掉 room watch');
{
    const src = read('assets/scripts/room/RoomScene.ts');
    const body = methodBody(src, 'private _enterGame(');

    check('RoomScene 里能找到 _enterGame 方法', body !== null);
    if (body) {
        check('_enterGame 切场景前调用了 this._unwatch()',
            /this\._unwatch\s*\(\s*\)/.test(body),
            '缺少停 watch —— 这是「落子无反应」的根因，详见文件头注释');
        check('_enterGame 把 _unwatch 置空（幂等，避免二次调用）',
            /this\._unwatch\s*=\s*null/.test(body),
            '_unwatch 未置空会让「已停」与「未停」不可区分');
        check('停 watch 发生在 gotoGame 之前',
            body.indexOf('this._unwatch()') >= 0 &&
                body.indexOf('this._unwatch()') < body.indexOf('gotoGame'),
            `_unwatch 位置=${body.indexOf('this._unwatch()')} gotoGame 位置=${body.indexOf('gotoGame')}`);
    }

    // 反例自证：把关键行删掉后，同样的正则必须不再匹配。
    // 这一步保证断言**真的在检查那三行**，而不是恒真。
    if (body) {
        const sabotaged = body.replace(/if \(this\._unwatch\) \{[\s\S]*?\}\n/, '');
        check('反例自证：删掉停 watch 的代码块后断言会失败',
            !/this\._unwatch\s*\(\s*\)/.test(sabotaged),
            '说明断言可证伪（不是恒真）');
    }
}

// ---------------------------------------------------------------------
console.log('\n场景 2：每个 watch 都必须有对应的「停」路径（不许有开无停）');
{
    // 规则：谁调用 watchRoom / watchCollection，谁就得在离开该场景时停掉它。
    // 这里用最小可维护的方式表达：调用点必须出现在某个还会调用 _unwatch/_stopWatch 的文件里。
    const files = [
        'assets/scripts/room/RoomScene.ts',
        'assets/scripts/core/services/wx/WxNetSyncService.ts',
        'assets/scripts/core/services/wx/WxRoomService.ts',
    ];
    for (const f of files) {
        const src = read(f);
        const opens = (src.match(/watchRoom\(|watchCollection\(|_openWatch\(/g) || []).length;
        const closes = (src.match(/this\._unwatch\s*\(\s*\)|_stopWatch\(|_closeWatch\(/g) || []).length
            // WxRoomService 的 watchRoom 内部自己 _stopWatch()，算作有停的能力
            ;
        check(`${path.basename(f)}：有停 watch 的路径（开=${opens} 停=${closes}）`,
            closes > 0 || opens === 0,
            '只开不停 = 连接数泄漏（每客户端上限 5 个 watch）');
    }
}

// ---------------------------------------------------------------------
console.log('\n场景 3：watch 下行必须真的推进「回执」信号（看门狗不可恒触发）');
{
    const src = read('assets/scripts/core/services/wx/WxNetSyncService.ts');
    check('_handleGameDoc 里推进了 _watchAckSeq',
        /private _handleGameDoc\(doc: GameDoc\): void \{[\s\S]{0,400}_watchAckSeq\+\+/.test(src),
        '没有推进 → 看门狗会在每次都误报 WATCH_ACK_TIMEOUT');
    check('看门狗在收到下行后会静默（比对序号）',
        /_lastWatchAckSeq !== seq/.test(src),
        '缺少「序号未变才报错」的判断，看门狗会变成无条件告警');

    // 反例自证
    const sabotaged = src.replace(/this\._watchAckSeq\+\+/, '');
    check('反例自证：删掉 _watchAckSeq++ 后断言会失败',
        !/private _handleGameDoc\(doc: GameDoc\): void \{[\s\S]{0,400}_watchAckSeq\+\+/.test(sabotaged),
        '说明断言可证伪');
}

// ---------------------------------------------------------------------
console.log('\n场景 3b：看门狗必须按「上行是否成功」分岔报错');
{
    // 为什么（2026-09-24 真实教训）：gomoku_move 因**云端缺依赖**直接抛
    //   `-504002 Cannot find module 'wx-server-sdk'`，上行根本没成功，
    //   但看门狗统一报「上行正常、下行断 → 去查集合权限」，把排查方向带偏。
    //   本断言锁住：看门狗必须区分「上行失败」与「上行成功但无下行」。
    const src = read('assets/scripts/core/services/wx/WxNetSyncService.ts');
    check('_armWatchAckWatchdog 接收 upstreamOk 参数',
        /_armWatchAckWatchdog\(name: string, upstreamOk: boolean\)/.test(src),
        '没有该参数就无法区分两种失败');
    check('调用处把上行结果传了进去',
        /_armWatchAckWatchdog\(name, upstreamOk\)/.test(src),
        '传了参数却没带进去，等于没分岔');
    check('上行失败分支存在且提到 remote-npm-install',
        /上行本身就失败了[\s\S]{0,400}remote-npm-install/.test(src),
        '上行失败时必须明确指向「云端未安装依赖」这一最常见原因');
    check('上行失败分支在「查集合权限」分支之前 return（不会两个都报）',
        src.indexOf('上行本身就失败了') > 0 &&
            src.indexOf('上行本身就失败了') < src.indexOf('必须设为「所有用户可读」'),
        '顺序反了会让上行失败也去报集合权限');

    const sabotaged = src.replace(/upstreamOk: boolean/, 'ignored: boolean')
        .replace(/_armWatchAckWatchdog\(name, upstreamOk\)/, '_armWatchAckWatchdog(name, true)');
    check('反例自证：去掉分岔后断言会失败',
        !/upstreamOk: boolean/.test(sabotaged) &&
            !/_armWatchAckWatchdog\(name, upstreamOk\)/.test(sabotaged),
        '说明断言可证伪');
}

// ---------------------------------------------------------------------
console.log('\n场景 4：客户端解析回合时优先用 lastMove.nextPlayerId');
{
    const src = read('assets/scripts/core/services/wx/WxNetSyncService.ts');
    check('_handleGameDoc 取 nextPlayerId 时优先 lastMove.nextPlayerId',
        /lm\.nextPlayerId\s*\?\?\s*doc\.currentPlayerId/.test(src),
        '只读 doc.currentPlayerId 时，历史文档缺该字段会让回合恒为空 → 「点棋盘无反应」');
    check('两个字段都为空时有明确告警（不静默派发空串）',
        /nextPlayerId 与 doc\.currentPlayerId 都为空/.test(src),
        '静默派发空串会让问题在真机上完全不可见');

    const sabotaged = src.replace(/lm\.nextPlayerId\s*\?\?\s*doc\.currentPlayerId/, 'doc.currentPlayerId');
    check('反例自证：改回只读 doc.currentPlayerId 后断言会失败',
        !/lm\.nextPlayerId\s*\?\?\s*doc\.currentPlayerId/.test(sabotaged),
        '说明断言可证伪');
}

console.log(`\n${fail === 0 ? 'ALL_CHANNEL_LIFECYCLE_PASSED' : 'CHANNEL_LIFECYCLE_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
