/**
 * extract-script-uuids.js —— 生成 `tools/script-uuids.json`（@ccclass 名 → 场景里用的压缩 uuid）。
 *
 * 背景（本项目的两次踩坑）：
 *   1. `.scene` 里脚本组件的 `__type__` 必须是**脚本压缩 uuid**，不是 `@ccclass` 名；
 *      写错编辑器会报 `Missing class: XxxScene`。
 *   2. 压缩 uuid 曾试图手写算法，结果与编辑器不一致（所以旧版改成去 temp/ 编译产物里
 *      grep `_RF.push({}, "<id>", "<Class>")` 提取）。但那样**新增脚本必须先让编辑器编译一次**，
 *      且 temp/ 被清空后就取不到值 —— headless 流程会卡住。
 *
 * 现在改为「按引擎权威算法推导 + 自校验」：
 *   · 算法来源：引擎 `cocos/core/utils/decode-uuid.ts`（解码）+ `misc.ts` 的 BASE64_KEYS。
 *     decode: 前 2 位 hex 原样保留；其后每 2 个 base64 字符编码 3 个 hex 字符
 *             hex1 = lhs>>2, hex2 = ((lhs&3)<<2)|(rhs>>4), hex3 = rhs&0xF
 *     脚本（类 id）用的是 reserved=5 的变体：前 5 位 hex 原样 + 其余 27 位 hex → 18 个 base64 字符（共 23 字符）。
 *   · 自校验（关键，防止"看似合理但错"）：
 *       ① 用 EDITOR_FIXTURES（从编辑器编译产物提取的权威值）比对推导结果，4/4 必须一致；
 *       ② 对每个生成的 uuid 做 decode(压缩) === 原 uuid 往返校验；
 *       ③ 若 temp/ 编译产物存在，再交叉比对一次真实构建值。
 *     任一项失败 → 直接抛错并提示「请让编辑器重新导入项目后重跑」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'assets', 'scripts');
const CHUNK_DIR = path.join(ROOT, 'temp', 'programming', 'packer-driver', 'targets', 'editor', 'chunks');

/** base64 字母表（引擎 cocos/core/utils/misc.ts 的 BASE64_KEYS）。 */
const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const BASE64_VALUES = new Array(123).fill(64);
for (let i = 0; i < 64; ++i) BASE64_VALUES[BASE64_KEYS.charCodeAt(i)] = i;

/**
 * 编辑器编译产物里提取的权威值（ground truth）。
 * 这些值来自 `_RF.push({}, "<id>", "<Class>")`，**不要在没有验证的情况下修改** ——
 * 它们是本工具推导算法的对照组。
 */
const EDITOR_FIXTURES = {
    LoadingScene: '51531AGReJLHZC8MLdX1gNx',
    LobbyScene: '137f0Ya7/NKx7CZ+fqyuKkN',
    RoomScene: '8d9dbGL9ntPZIy97SbIdQRR',
    GameScene: 'f5c77wx5MpNmr+5eqV1ryKe',
};

/** uuid → 压缩 uuid（reserved=5：脚本类 id 用 23 位；reserved=2：资源用 22 位）。 */
function compressUuid(uuid, min = false) {
    const hex = uuid.replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) {
        throw new Error('compressUuid: 非法 uuid ' + uuid);
    }
    const reserved = min ? 2 : 5;
    const rest = hex.slice(reserved);
    if (rest.length % 3 !== 0) {
        throw new Error('compressUuid: 长度不合法 ' + rest.length);
    }
    let out = hex.slice(0, reserved);
    for (let i = 0; i < rest.length; i += 3) {
        const h1 = parseInt(rest[i], 16);
        const h2 = parseInt(rest[i + 1], 16);
        const h3 = parseInt(rest[i + 2], 16);
        const lhs = (h1 << 2) | (h2 >> 2);
        const rhs = ((h2 & 3) << 4) | h3;
        out += BASE64_KEYS[lhs] + BASE64_KEYS[rhs];
    }
    return out;
}

/** 压缩 uuid → uuid（照抄引擎 decode-uuid.ts 的逻辑，用于自校验）。 */
function decodeUuid(base64) {
    if (base64.length !== 22) return null; // 23 位脚本 id 用 decode23 变体
    return decode23(base64, 2);
}

/**
 * 通用解码（reserved = 2 或 5），返回 32 位 hex（带 '-' 的 36 位由调用方格式化）。
 */
function decode23(compressed, reserved) {
    const hexChars = '0123456789abcdef';
    let hex = compressed.slice(0, reserved);
    for (let i = reserved; i < compressed.length; i += 2) {
        const lhs = BASE64_VALUES[compressed.charCodeAt(i)];
        const rhs = BASE64_VALUES[compressed.charCodeAt(i + 1)];
        if (lhs === 64 || rhs === 64) return null;
        hex += hexChars[lhs >> 2] + hexChars[((lhs & 3) << 2) | (rhs >> 4)] + hexChars[rhs & 0xf];
    }
    return hex;
}

/** 收集所有 @ccclass 脚本（含其 .meta uuid）。 */
function collectClasses() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (e.name.endsWith('.ts')) {
                const src = fs.readFileSync(p, 'utf8');
                const metaPath = p + '.meta';
                if (!fs.existsSync(metaPath)) {
                    throw new Error('缺少 .meta（编辑器未导入？）: ' + path.relative(ROOT, metaPath));
                }
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                const re = /@ccclass\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
                let m;
                while ((m = re.exec(src))) {
                    out.push({ cls: m[1], file: path.relative(ROOT, p).replace(/\\/g, '/'), uuid: meta.uuid });
                }
            }
        }
    };
    walk(SCRIPTS_DIR);
    return out.sort((a, b) => a.cls.localeCompare(b.cls));
}

/** 若存在编辑器构建产物，提取其中的 _RF.push 值做交叉比对（可选增强）。 */
function editorIds() {
    const found = {};
    if (!fs.existsSync(CHUNK_DIR)) return found;
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) {
                const src = fs.readFileSync(p, 'utf8');
                const re = /_RF\.push\(\{\},\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
                let m;
                while ((m = re.exec(src))) found[m[2]] = m[1];
            }
        }
    };
    walk(CHUNK_DIR);
    return found;
}

function main() {
    // ---------- 0. 算法自校验：必须能复现编辑器权威值，否则一律不准写入 ----------
    const fixtures = [
        ['LoadingScene', 'assets/scripts/lobby/LoadingScene.ts'],
        ['LobbyScene', 'assets/scripts/lobby/LobbyScene.ts'],
        ['RoomScene', 'assets/scripts/room/RoomScene.ts'],
        ['GameScene', 'assets/scripts/room/GameScene.ts'],
    ];
    let mustFail = 0;
    for (const [cls, rel] of fixtures) {
        const meta = JSON.parse(fs.readFileSync(path.join(ROOT, rel + '.meta'), 'utf8'));
        const computed = compressUuid(meta.uuid);
        const expect = EDITOR_FIXTURES[cls];
        const ok = computed === expect;
        if (!ok) mustFail++;
        console.log(
            '[self-check] ' + cls.padEnd(14) +
            ' uuid=' + meta.uuid +
            ' computed=' + computed +
            ' editor=' + expect +
            (ok ? '  OK' : '  MISMATCH'),
        );
    }
    if (mustFail > 0) {
        throw new Error(
            '压缩 uuid 推导与编辑器权威值不一致（' + mustFail + ' 项）—— ' +
            '不要相信本次输出，请让 Cocos 编辑器重新导入项目后再跑本脚本',
        );
    }

    // ---------- 1. 收集 + 生成 ----------
    const rows = collectClasses();
    const map = {};
    for (const r of rows) {
        const cid = compressUuid(r.uuid);
        const back = decode23(cid, 5);
        if (back !== r.uuid.replace(/-/g, '').toLowerCase()) {
            throw new Error('往返校验失败: ' + r.cls + ' ' + cid + ' → ' + back);
        }
        if (cid.length !== 23) {
            throw new Error('压缩 uuid 长度异常: ' + r.cls + ' → ' + cid.length);
        }
        if (map[r.cls]) {
            throw new Error('重复的 @ccclass 名: ' + r.cls + '（Cocos 类名必须全局唯一）');
        }
        map[r.cls] = cid;
    }

    // ---------- 2. 与编辑器构建产物交叉比对（存在则必须一致）----------
    const ids = editorIds();
    let crossChecked = 0;
    for (const [cls, cid] of Object.entries(map)) {
        if (ids[cls] && ids[cls] !== cid) {
            throw new Error(
                '与编辑器构建产物不一致: ' + cls + ' computed=' + cid + ' editor=' + ids[cls] +
                '（脚本 .meta uuid 被改过？请重跑或让编辑器重新导入）',
            );
        }
        if (ids[cls]) crossChecked++;
    }

    fs.writeFileSync(path.join(__dirname, 'script-uuids.json'), JSON.stringify(map, null, 2) + '\n', 'utf8');
    console.log('\n已写入 tools/script-uuids.json（' + Object.keys(map).length + ' 个类，编辑器交叉比对 ' + crossChecked + ' 个）:');
    for (const [cls, cid] of Object.entries(map)) {
        console.log('  ' + cls.padEnd(16) + cid + '  (' + (ids[cls] ? 'editor-verified' : 'derived+roundtrip') + ')');
    }
}

main();