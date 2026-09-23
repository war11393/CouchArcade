/**
 * AI 练习房「开局被拦」回归测试（开发辅助脚本，不参与游戏运行）。
 *
 * 背景（2026-09-23 真机事故）：
 *   「开始游戏 → AI 练习」后能进房间，但**无法开局**。
 *   症状：进房即自动调用 startGame，服务端必然抛
 *   「需全员入座并准备后才能开始」；房主手动点「准备」也救不了。
 *
 * 根因：
 *   startGame 的开门条件是 allSeated && allReady（每个座位都要
 *   playerId 非空且 ready）。而 createRoom 对 practice=true 只写了
 *   isPractice=true，**其余座位仍是 playerId='' 的空位** ——
 *   空位永远不会变 AI、也不会 ready，于是条件恒为 false。
 *   客户端却因「isPractice=true 就无条件自动开局」而反复重试。
 *
 * 本测试做两件事：
 *   ① 静态断言：三个云函数源码里的关键判定/座位构造符合修复后的形态；
 *   ② 逻辑复刻：把「建房 → 开局」的座位演化按服务端代码复刻一遍，
 *      断言修复前必被拦、修复后可开局（旧行为作为反例保留）。
 *
 * 运行：node tools/test-cloud-ai-seat.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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

// =====================================================================
// 复刻服务端判定（与 cloudfunctions/startGame|ready 的口径一致）
// =====================================================================

/** startGame 的开门条件（与 cloudfunctions/startGame/index.js 保持一致）。 */
function startGameAllows(seats, isPractice) {
    const allSeated = seats.every((s) => !!s.playerId);
    const allReady = seats.every((s) => {
        if (!s.playerId) return false;
        if (s.isAI) return true;
        if (isPractice && s.seatIndex === 0) return true; // 练习房房主免准备
        return !!s.ready;
    });
    return allSeated && allReady;
}

/** 建房时按「修复前 / 修复后」两种写法生成座位。 */
function buildSeats(practice, ownerId, maxPlayers, aiNicknames, fixed) {
    const seats = [
        {
            seatIndex: 0, playerId: ownerId, nickname: '微信用户', ready: false,
            online: true, isOwner: true, isAI: false, score: 0,
        },
    ];
    for (let i = 1; i < maxPlayers; i++) {
        // 修复前：一律空位（practice 也不例外）
        seats.push({
            seatIndex: i, playerId: '', nickname: '', ready: false,
            online: false, isOwner: false, isAI: false, score: 0,
        });
    }
    if (fixed && practice) {
        for (let i = 1; i < maxPlayers; i++) {
            seats[i] = {
                seatIndex: i, playerId: `ai-room-${i}`,
                nickname: aiNicknames[(i - 1) % aiNicknames.length], ready: true,
                online: true, isOwner: false, isAI: true, score: 0,
            };
        }
    }
    return seats;
}

console.log('=== AI 练习房开局回归测试 ===\n');

// ---------------------------------------------------------------------
console.log('场景 1：修复前——练习房建完仍有空位，开局必被拦（反例）');
// ---------------------------------------------------------------------
{
    const seats = buildSeats(true, 'oOwner', 2, ['机头猎手'], false);
    check('房主已入座但对手是空位', seats[0].playerId === 'oOwner' && seats[1].playerId === '',
        JSON.stringify(seats.map((s) => s.playerId)));
    check('startGame 拒绝（复现事故症状）', !startGameAllows(seats, true),
        '修复前应当为 false —— 若这里为 true 说明反例失效，测试本身有问题');

    // 「房主手动点准备」也救不了：空位不会因此变成 AI
    seats[0] = Object.assign({}, seats[0], { ready: true });
    check('房主手动准备后仍被拒（解释「点准备也没用」）', !startGameAllows(seats, true));
}

// ---------------------------------------------------------------------
console.log('\n场景 2：修复后——建库即填 AI 座位并置 ready，开局放行');
// ---------------------------------------------------------------------
{
    const seats = buildSeats(true, 'oOwner', 2, ['机头猎手'], true);
    check('所有座位都有 playerId', seats.every((s) => !!s.playerId));
    check('AI 座位 isAI=true', seats[1].isAI === true);
    check('AI 座位 ready=true（AI 不会自己点准备）', seats[1].ready === true);
    check('房主未点准备也能开局（与 Mock 参考实现一致）', seats[0].ready === false
        && startGameAllows(seats, true),
        JSON.stringify(seats.map((s) => `${s.playerId}:${s.ready}`)));
}

// ---------------------------------------------------------------------
console.log('\n场景 3：联机房不受影响（不能靠宽松判定把联机也放行）');
// ---------------------------------------------------------------------
{
    const seats = buildSeats(false, 'oOwner', 2, ['机头猎手'], true);
    check('联机房对手仍是空位', seats[1].playerId === '');
    check('联机开局仍被拦（等待真人入座）', !startGameAllows(seats, false));

    // 真人入座但未准备 → 仍要拦
    seats[1] = Object.assign({}, seats[1], { playerId: 'oOther', nickname: '对手' });
    check('真人入座未准备 → 仍拦', !startGameAllows(seats, false));

    // 房主自己未准备也要拦（联机房没有免准备特权）
    check('联机房房主未准备 → 仍拦', !startGameAllows(seats, false));

    // 双方都准备 → 放行
    seats[0] = Object.assign({}, seats[0], { ready: true });
    seats[1] = Object.assign({}, seats[1], { ready: true });
    check('双方入座且准备 → 放行', startGameAllows(seats, false));
}

// ---------------------------------------------------------------------
console.log('\n场景 4：历史房间兼容（旧数据 AI 座位 ready=false 也要能开局）');
// ---------------------------------------------------------------------
{
    // 本次修复前创建、且已被填入 AI 的历史房间：playerId 有、ready 为 false
    const legacy = [
        { seatIndex: 0, playerId: 'oOwner', nickname: '微信用户', ready: false, isAI: false },
        { seatIndex: 1, playerId: 'ai-old-1', nickname: '机头猎手', ready: false, isAI: true },
    ];
    check('历史房间（AI ready=false）也能开局', startGameAllows(legacy, true),
        '靠 allReady 里的 isAI / 练习房房主放行兜住');
    check('历史联机房（AI 标记但不该放行）不误放', !startGameAllows(legacy, false));
}

// ---------------------------------------------------------------------
console.log('\n场景 5：静态断言——三个云函数源码符合修复形态');
// ---------------------------------------------------------------------
{
    const createRoomSrc = read('cloudfunctions/createRoom/index.js');
    const startGameSrc = read('cloudfunctions/startGame/index.js');
    const readySrc = read('cloudfunctions/ready/index.js');

    check('createRoom 在 practice 时写入 AI 座位', /if\s*\(practice\)/.test(createRoomSrc)
        && /isAI:\s*true/.test(createRoomSrc), 'createRoom 缺少 practice 分支的 AI 座位构造');
    check('createRoom 的 AI 座位 ready 为 true', /isAI:\s*true[\s\S]{0,200}?score/.test(createRoomSrc)
        && /ready:\s*true/.test(createRoomSrc));
    check('createRoom 声明了 AI_NICKNAMES 昵称池', /const AI_NICKNAMES\s*=/.test(createRoomSrc));

    check('startGame 的 allReady 放行 isAI', /if\s*\(s\.isAI\)\s*return true/.test(startGameSrc),
        'startGame 仍用严格 s.ready —— 历史房间会开不了局');
    check('startGame 对练习房房主免准备', /room\.isPractice\s*&&\s*s\.seatIndex === 0/.test(startGameSrc));
    check('startGame 拦截时打印逐座位明细', /开局被拦/.test(startGameSrc));

    check('ready 的练习房直接置 READY', /room\.isPractice/.test(readySrc)
        && /ROOM_STATUS\.READY/.test(readySrc));
    check('ready 的 allReady 放行 isAI', /\(s\.ready\s*\|\|\s*!!s\.isAI\)/.test(readySrc));
}

// ---------------------------------------------------------------------
console.log('\n场景 6：昵称池与客户端 AppConfig 保持一致');
// ---------------------------------------------------------------------
{
    const createRoomSrc = read('cloudfunctions/createRoom/index.js');
    const appConfigSrc = read('assets/scripts/config/AppConfig.ts');

    const serverMatch = createRoomSrc.match(/const AI_NICKNAMES\s*=\s*\[([^\]]*)\]/);
    const clientIdx = appConfigSrc.indexOf('MOCK_OPPONENT_NICKNAMES');
    // ⚠️ 不能用 indexOf(']') —— 声明行里就有 `readonly string[]`，
    //    会在数组字面量之前就截断（曾因此解析出 0 个昵称）。
    //    从 `= [` 之后找闭合括号才是数组字面量的边界。
    let clientBlock = '';
    if (clientIdx >= 0) {
        const arrStart = appConfigSrc.indexOf('= [', clientIdx);
        if (arrStart >= 0) {
            const arrEnd = appConfigSrc.indexOf(']', arrStart);
            if (arrEnd > arrStart) {
                clientBlock = appConfigSrc.slice(arrStart, arrEnd);
            }
        }
    }

    // 昵称在两侧的引号风格不同：云函数是 JS 单引号、AppConfig 是 TS 单引号，
    // 但为稳妥两种引号都认（避免以后哪边改成双引号就静默解析成 0 个）。
    const names = (s) => (s.match(/'[^']+'|"[^"]+"/g) || []).map((x) => x.replace(/['"]/g, ''));
    const serverNames = serverMatch ? names(serverMatch[1]) : [];
    // 客户端是 TS 数组字面量，逐行列出：从声明处截到第一个 ']' 即可
    const clientNames = names(clientBlock);

    check('服务端昵称池非空', serverNames.length > 0, `解析到 ${serverNames.length} 个`);
    check('客户端昵称池非空（解析成功）', clientNames.length > 0, `解析到 ${clientNames.length} 个`);
    check('两侧昵称池完全一致', serverNames.join('|') === clientNames.join('|'),
        `服务端=[${serverNames.join(',')}] 客户端=[${clientNames.join(',')}]`);
}

// ---------------------------------------------------------------------
console.log('\n场景 7：客户端 RoomScene 不再误报「可开局」');
// ---------------------------------------------------------------------
{
    const roomSrc = read('assets/scripts/room/RoomScene.ts');
    check('自动开局要求练习房全员入座', /state\.isPractice\s*&&\s*allSeated/.test(roomSrc),
        '仍是无条件 isPractice 自动开局');
    check('_onStart 有并发闸（_starting）', /this\._starting/.test(roomSrc),
        '重复 watch 推送会并发 startRoom');
    check('按钮日志区分 全员入座/全员就绪', /全员入座=/.test(roomSrc) && /全员就绪=/.test(roomSrc));
}

// ---------------------------------------------------------------------
console.log('\n场景 8：AI 练习无准备环节（需求：点 AI 练习直接进对局）');
// ---------------------------------------------------------------------
{
    const roomSrc = read('assets/scripts/room/RoomScene.ts');

    check('练习房隐藏「准备」按钮', /_setReadyButtonVisible\(!state\.isPractice\)/.test(roomSrc),
        '准备按钮未按 isPractice 隐藏');
    check('隐藏时把「离开」按钮居中', /visible \? 163 : 0/.test(roomSrc),
        '隐藏准备后离开未居中，会留下空洞');
    check('隐藏/显示状态做了去重（避免每次推送重排）', /this\._readyHidden === !visible/.test(roomSrc));
    check('练习房文案不再要求点准备', !/点击「开始游戏」开局/.test(roomSrc),
        '仍残留「点击开始游戏开局」的旧文案');

    // 关键：练习房「无准备环节」能成立，靠的是服务端放行条件自洽 ——
    // 房主免准备 + AI 免准备，两者缺一就会出现「按钮没了但开不了局」。
    const startGameSrc = read('cloudfunctions/startGame/index.js');
    check('服务端：练习房房主免准备（配合按钮隐藏）',
        /room\.isPractice\s*&&\s*s\.seatIndex === 0/.test(startGameSrc),
        '若服务端仍要求房主 ready，隐藏按钮后将无法开局');
    const practiceSeats = buildSeats(true, 'oOwner', 2, ['机头猎手'], true);
    check('无准备环节也能开局（房主 ready=false + AI ready=true）',
        practiceSeats[0].ready === false && startGameAllows(practiceSeats, true));
}

console.log(`\n${fail === 0 ? 'ALL_AI_SEAT_TESTS_PASSED' : 'AI_SEAT_FAILURES=' + fail}` +
    `  (${pass} 通过, ${fail} 失败)`);
process.exit(fail === 0 ? 0 : 1);
