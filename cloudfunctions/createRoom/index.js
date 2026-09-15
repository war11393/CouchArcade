/**
 * 云函数 createRoom —— 创建房间（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'createRoom', data: { gameId, practice, aiLevel } })
 *
 * 服务端职责：
 * 1. 生成唯一 6 位房间号（冲突时重试）；
 * 2. 创建者坐 0 号位并成为房主；
 * 3. practice=true（AI 练习）时不建议走此云函数（应由客户端本地开展以省资源），
 *    但此处保留支持以便统计。
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
