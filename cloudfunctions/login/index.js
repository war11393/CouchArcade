/**
 * 云函数 login —— 静默登录换取 openid（第二阶段部署）。
 *
 * 调用：wx.cloud.callFunction({ name: 'login', data: { nickname, avatarUrl } })
 * 返回：{ code, success, data: { openid, nickname, avatarUrl, winCount, loseCount, drawCount } }
 *
 * 关键：openid 由 cloud.getWXContext() 直接获得（微信服务端注入，无法伪造），
 * 无需客户端传 code 再走 code2Session —— 这是小游戏云开发的标准做法。
 */

const { wrap, upsertUser, ok } = require('./common');

exports.main = wrap('login', async function (ctx, event) {
    // 昵称/头像为可选（第二阶段由客户端经 chooseAvatar/nickname 组件收集后传入）
    const user = await upsertUser(ctx, event.nickname, event.avatarUrl);

    console.log(`[login] openid=${ctx.openid} nickname=${user.nickname}`);

    return ok({
        openid: user.openid,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        winCount: user.winCount || 0,
        loseCount: user.loseCount || 0,
        drawCount: user.drawCount || 0,
    });
});
