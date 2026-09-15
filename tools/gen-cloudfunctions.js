/**
 * 生成各云函数的 package.json 与公共模块副本（开发辅助脚本）。
 *
 * 用途：
 * 1. 为每个云函数目录生成 package.json（依赖 wx-server-sdk）；
 * 2. 把 cloudfunctions/common/ 复制到每个云函数目录下，
 *    因为微信云函数不支持 require 上级目录，公共模块必须随包携带。
 *
 * 运行：node tools/gen-cloudfunctions.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudfunctions');

/** 云函数名 → 描述 */
const FUNCTIONS = {
    login: '静默登录：换取 openid 并 upsert users 集合',
    createRoom: '创建房间：分配唯一 6 位房间号，创建者坐 0 号位',
    joinRoom: '加入/离开房间：占座（乐观锁防并发）、房主移交、解散判定',
    ready: '设置准备状态：全员准备后房间进入 ready',
    startGame: '房主开局：生成随机种子与权威布局，房间进入 playing',
    getRoomState: '拉取房间全量状态：断线重连兜底 + 惰性超时解散',
    planehunt_flip: '寻机头翻格（服务端权威）：返回真实格子内容，机头奖励连翻',
    gomoku_move: '五子棋落子（服务端权威）：合法性校验 + 四方向五连检测',
    settleGame: '对局结算：以服务端权威结果写 match_records 并更新用户战绩',
};

function main() {
    const commonDir = path.join(CF_DIR, 'common');
    if (!fs.existsSync(commonDir)) {
        console.error('cloudfunctions/common 不存在，请先创建公共模块');
        process.exit(1);
    }
    const commonSrc = fs.readFileSync(path.join(commonDir, 'index.js'), 'utf8');

    const names = Object.keys(FUNCTIONS);
    for (const name of names) {
        const dir = path.join(CF_DIR, name);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // package.json
        const pkg = {
            name: name,
            version: '1.0.0',
            description: FUNCTIONS[name],
            main: 'index.js',
            dependencies: {
                'wx-server-sdk': '~2.6.3',
            },
        };
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

        // 公共模块副本（云函数不能 require 上级目录）
        fs.writeFileSync(path.join(dir, 'common.js'), commonSrc, 'utf8');

        console.log(`prepared cloudfunctions/${name}/ (package.json + common.js)`);
    }

    console.log(`\ndone. ${names.length} cloud functions prepared:`);
    console.log('  ' + names.join(', '));
}

main();
