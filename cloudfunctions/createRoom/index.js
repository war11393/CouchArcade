/**
 * 云函数 createRoom —— 创建房间（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'createRoom', data: { gameId, practice, aiLevel } })
 *
 * 服务端职责：
 * 1. 生成唯一 6 位房间号（冲突时重试）；
 * 2. 创建者坐 0 号位并成为房主；
 * 3. practice=true（AI 练习）时，**建库即填入 AI 座位并置 ready** ——
 *    否则 startGame 的 allSeated/allReady 校验必然失败（详见座位构造处注释）。
 */

const {
    wrap,
    COLLECTIONS,
    ROOM_STATUS,
    ERR,
    BizError,
    ok,
    genRoomId,
    genSeed,
    upsertUser,
} = require('./common');

/** 各游戏所需玩家数（与客户端 GameList.ts 保持一致）。 */
const PLAYER_COUNT = {
    planehunt: 2,
    gomoku: 2,
};

/** 房间号最大重试次数。 */
const MAX_ROOM_ID_RETRY = 10;

/**
 * AI 对手昵称池（与客户端 AppConfig.MOCK_OPPONENT_NICKNAMES 保持一致）。
 *
 * ⚠️ 服务端不 import 客户端代码（云函数是独立部署的 JS），只能这样成对维护。
 * 改一边必须改另一边 —— `tools/test-cloud-ai-seat.js` 会断言两处一致。
 */
const AI_NICKNAMES = ['机头猎手', '五子小王子', '摸鱼达人', '路人甲', '深夜棋手'];

exports.main = wrap('createRoom', async function (ctx, event) {
    const gameId = event.gameId;
    const practice = !!event.practice;
    const aiLevel = event.aiLevel || 2;

    if (!gameId || !PLAYER_COUNT[gameId]) {
        throw new BizError(ERR.INVALID_MOVE, `不支持的游戏: ${gameId}`);
    }

    const user = await upsertUser(ctx, event.nickname, event.avatarUrl);
    const maxPlayers = PLAYER_COUNT[gameId];
    const now = Date.now();

    // 生成唯一房间号
    let roomId = '';
    for (let i = 0; i < MAX_ROOM_ID_RETRY; i++) {
        const candidate = genRoomId();
        const dup = await ctx.db
            .collection(COLLECTIONS.ROOMS)
            .where({ roomId: candidate, status: ctx._.nin([ROOM_STATUS.DISSOLVED, ROOM_STATUS.FINISHED]) })
            .count();
        if (dup.total === 0) {
            roomId = candidate;
            break;
        }
    }
    if (!roomId) {
        throw new BizError(ERR.INTERNAL, '房间号分配失败，请重试');
    }

    // 座位：0 号位为房主，其余空位
    const seats = [];
    seats.push({
        seatIndex: 0,
        playerId: ctx.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        ready: false,
        online: true,
        isOwner: true,
        isAI: false,
        aiLevel: aiLevel,
        score: 0,
    });
    for (let i = 1; i < maxPlayers; i++) {
        seats.push({
            seatIndex: i,
            playerId: '',
            nickname: '',
            avatarUrl: '',
            ready: false,
            online: false,
            isOwner: false,
            isAI: false,
            aiLevel: aiLevel,
            score: 0,
        });
    }

    // AI 练习房：**建库时就把对手座位填成 AI 并置 ready**。
    //
    // 为什么必须在建库时做（这是「AI 练习点了没反应」的根因）：
    //   startGame 的开门条件是 allSeated && allReady（见 startGame/index.js）。
    //   以前 createRoom 对 practice 只写了 isPractice=true，其余座位仍是
    //   playerId='' 的**空位** —— 于是客户端一进房就自动开局，服务端必然
    //   抛「需全员入座并准备后才能开始」，且房主手动点「准备」也救不了
    //   （空位不会因为房主准备而变成 AI），表现为「进房卡死、无法开局」。
    //   AI 座位由**服务端**落库（不放客户端），这样 ready/startGame 的
    //   判定在服务端自洽，且联机房不受影响。
    if (practice) {
        for (let i = 1; i < maxPlayers; i++) {
            seats[i] = {
                seatIndex: i,
                playerId: 'ai-' + roomId + '-' + i,
                nickname: AI_NICKNAMES[(i - 1) % AI_NICKNAMES.length],
                avatarUrl: '',
                // ⚠️ ready 必须为 true：AI 不会自己点准备
                ready: true,
                online: true,
                isOwner: false,
                isAI: true,
                aiLevel: aiLevel,
                score: 0,
            };
        }
    }

    const room = {
        roomId: roomId,
        gameId: gameId,
        status: ROOM_STATUS.WAITING,
        seats: seats,
        ownerId: ctx.openid,
        maxPlayers: maxPlayers,
        isPractice: practice,
        // 练习房间本地生成种子即可；联机房间在 startGame 时生成权威种子
        seed: practice ? genSeed() : 0,
        createdAt: now,
        updatedAt: now,
        // 房间超时时间戳（配合定时触发器清理，或由 getRoomState 惰性判定）
        expireAt: now + 30 * 60 * 1000,
    };

    await ctx.db.collection(COLLECTIONS.ROOMS).add({ data: room });

    console.log(`[createRoom] roomId=${roomId} gameId=${gameId} owner=${ctx.openid}`);
    return ok(room);
});
