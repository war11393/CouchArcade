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
    check('_handleGameDoc 里推进了 _watchAckCount',
        /private _handleGameDoc\(doc: GameDoc\): void \{[\s\S]{0,400}_watchAckCount\+\+/.test(src),
        '没有推进 → 看门狗会在每次都误报 WATCH_ACK_TIMEOUT');
    check('看门狗按「基线计数」比对（下行到得比 callFunction 返回快也不误报）',
        /const baseline = this\._watchAckCount;/.test(src) &&
            /_watchAckCount > baseline/.test(src),
        '旧实现用「arm 时清零」判回执，而真机 watch 常先于 Promise 返回到达 → 每次落子必误报');
    check('看门狗在 disconnect 时统一清理（不留残报）',
        /for \(const t of this\._watchdogs\)/.test(src),
        '离开对局后冒出的 WATCH_ACK_TIMEOUT 只会吓到下一次排查的人');

    // 反例自证
    const sabotaged = src.replace(/this\._watchAckCount\+\+/, '');
    check('反例自证：删掉 _watchAckCount++ 后断言会失败',
        !/private _handleGameDoc\(doc: GameDoc\): void \{[\s\S]{0,400}_watchAckCount\+\+/.test(sabotaged),
        '说明断言可证伪');
    const sabotaged2 = src.replace(/const baseline = this\._watchAckCount;/, 'const baseline = 0;');
    check('反例自证：基线清零（旧缺陷）后断言会失败',
        !/const baseline = this\._watchAckCount;/.test(sabotaged2),
        '说明断言可证伪');
}

// ---------------------------------------------------------------------
console.log('\n场景 3b：上行失败必须当场报错 + 取消看门狗（不再延迟误导）');
{
    // 为什么（2026-09-24 两次真实误导）：
    //   ① 云端缺依赖时，旧看门狗统一报「上行正常、下行断 → 查集合权限」；
    //   ② watch 先于返回到达时，旧 arm 时机（返回之后）导致每次都误报。
    //   现在：失败分支当场 console.error（含「云端缺依赖怎么修」）并 cancel；
    //   只有「已受理但始终无下行」才由看门狗提示查集合/权限。
    const src = read('assets/scripts/core/services/wx/WxNetSyncService.ts');
    check('上行失败分支取消看门狗（≥3 处 cancelWatchdog：业务失败/空返回/catch）',
        (src.match(/cancelWatchdog\(\);/g) || []).length >= 3,
        `实际 ${(src.match(/cancelWatchdog\(\);/g) || []).length} 处`);
    check('catch 分支对 Cannot find module 给出部署指引',
        /Cannot find module[\s\S]{0,200}remote-npm-install/.test(src),
        '缺依赖是踩过的坑，报错里必须直接写怎么修');
    check('看门狗文案不再断言「已被服务端受理」（arm 早于返回，当时还不知道）',
        !/WATCH_ACK_TIMEOUT：\$\{name\} 已被服务端受理/.test(src),
        'arm 在发出前，报「已受理」是不诚实的措辞');
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

// ---------------------------------------------------------------------
console.log('\n场景 5：connect() 之前必须 setGameId（否则 watch 监听错集合）');
{
    // 为什么（2026-09-24 真机事故第二发）：WxNetSyncService 按 gameId 决定
    //   watch 哪个集合，未设置时**静默回落到 rooms**（只有房间状态、没有棋步）。
    //   上行云函数写库正常、下行永远等不到 —— 表现与权限问题几乎一样，
    //   日志里那句 `gameId=未指定` 完全被淹没。修复=GameScene 在
    //   game.onEnter()（内部 connect→_openWatch）之前调 netSync.setGameId()。
    const game = read('assets/scripts/room/GameScene.ts');
    check('GameScene 在 onEnter 之前调用 setGameId',
        game.search(/netSync\.setGameId\(gameId\);/) >= 0 &&
            game.search(/netSync\.setGameId\(gameId\);/) <
                game.search(/^\s+game\.onEnter\(\);$/m),
        'setGameId 必须在真实代码行上早于 game.onEnter() 调用（注释不算）');

    const net = read('assets/scripts/core/services/wx/WxNetSyncService.ts');
    check('_openWatch 对 gameId 未设置打 error 级告警（不再静默）',
        /gameId 未设置[\s\S]{0,160}console\.error|console\.error\(\s*\n?\s*'?\[WxNetSync\] gameId 未设置/.test(net) &&
            /gameId 未设置/.test(net),
        '静默回落 rooms 是本次事故的直接形态，必须显式暴露');

    const sabotaged = game.replace(/netSync\.setGameId\(gameId\);/, '');
    check('反例自证：删掉 setGameId 调用后断言会失败',
        sabotaged.indexOf('setGameId(gameId)') < 0 ||
            sabotaged.indexOf('setGameId(gameId)') > sabotaged.indexOf('game.onEnter()'),
        '说明断言可证伪');
}

// ---------------------------------------------------------------------
console.log('\n场景 6：重开对局必须强制重载场景（不能复用当前 Game 场景）');
{
    // 为什么（2026-09-24 真机）：_restartGame 走 gotoGame → _load 的幂等闸
    //   「已在目标场景就跳过」把重开吞掉了：场景没重载、旧对局控制器继续
    //   update → 再次 _showResult（弹窗重复弹）+ 用旧数据再写一次战绩
    //   （settleGame 云函数 3s 超时 -504003）。修复 = UIManager.reloadGame
    //   绕过幂等闸强制 loadScene。
    const gs = read('assets/scripts/room/GameScene.ts');
    const ui = read('assets/scripts/core/UIManager.ts');
    check('UIManager 提供 reloadGame（强制重载，绕过幂等闸）',
        /public reloadGame\(params: GameSceneParams\): void \{/.test(ui) &&
            /reloadGame[\s\S]{0,400}director\.loadScene\(SCENES\.GAME\)/.test(ui),
        '缺 reloadGame 或它没绕过幂等闸，重开会退化成空操作');
    check('_restartGame 调 reloadGame 而非 gotoGame',
        /private _restartGame\(\): void \{[\s\S]{0,1200}uiManager\.reloadGame\(\{/.test(gs),
        '仍是 gotoGame → 会再次被「已在场景」幂等闸吞掉');
    check('_hudTick 的结算入口有 _savedRecord 幂等闸',
        /isFinished\(\) && !this\._savedRecord/.test(gs),
        '结算可能被重复触发（弹窗重复弹 + 重复写战绩）');

    const sabotaged = gs.replace(/uiManager\.reloadGame\(\{/, 'uiManager.gotoGame({');
    check('反例自证：改回 gotoGame 后断言会失败',
        !/private _restartGame\(\): void \{[\s\S]{0,1200}uiManager\.reloadGame\(\{/.test(sabotaged),
        '说明断言可证伪');
}

console.log(`\n${fail === 0 ? 'ALL_CHANNEL_LIFECYCLE_PASSED' : 'CHANNEL_LIFECYCLE_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
