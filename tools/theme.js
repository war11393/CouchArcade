/**
 * theme.js —— 解析 `assets/scripts/config/UITheme.ts` 的设计令牌，供静态场景生成/校验使用。
 *
 * 为什么用「解析 TS」而不是在工具里再抄一份色板：
 *   抄两份必然漂移（改一处忘另一处，界面就会出现两种白/两种蓝）。
 *   这里把 UITheme.ts 当唯一来源；解析不到/解析残留都会**直接抛错**，不会静默用错值。
 *
 * 约束：UITheme.ts 里的 PALETTE / BOARD / RADIUS / SPACE / FONT / LAYOUT 必须是
 *   `export const NAME = { key: '<hex>' | number, ... } as const;` 的字面量形式。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'scripts', 'config', 'UITheme.ts');

/** hex 色板块（值必须是 '#RRGGBB'）。 */
const HEX_BLOCKS = ['PALETTE', 'BOARD'];
/** 数值块。 */
const NUM_BLOCKS = ['RADIUS', 'SPACE', 'FONT', 'LAYOUT'];

function readSource() {
    if (!fs.existsSync(SRC)) {
        throw new Error('theme.js: 找不到设计令牌文件 ' + SRC);
    }
    return fs.readFileSync(SRC, 'utf8');
}

function blockBody(src, name) {
    const re = new RegExp('export const\\s+' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\}\\s*as const;', 'm');
    const m = src.match(re);
    if (!m) {
        throw new Error(
            'theme.js: UITheme.ts 中找不到 `export const ' + name + ' = { ... } as const;` —— ' +
            '令牌块被改名/改形了，静态场景生成与主题校验都会失效',
        );
    }
    return m[1];
}

/** 去掉注释，便于做「残留未解析条目」检查。 */
function stripComments(body) {
    return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const VALUE_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('(?:#[0-9A-Fa-f]{6})'|-?\d+(?:\.\d+)?)/g;

function parseBlock(src, name, kind) {
    const body = stripComments(blockBody(src, name));
    const out = {};
    let m;
    VALUE_RE.lastIndex = 0;
    while ((m = VALUE_RE.exec(body))) {
        const key = m[1];
        const raw = m[2];
        if (raw.startsWith("'")) {
            if (kind === 'num') {
                throw new Error('theme.js: ' + name + '.' + key + ' 期望数字，实际是 hex 字符串');
            }
            out[key] = raw.slice(1, -1);
        } else {
            if (kind === 'hex') {
                throw new Error('theme.js: ' + name + '.' + key + ' 期望 hex 字符串（单引号 #RRGGBB）');
            }
            out[key] = Number(raw);
        }
    }

    // 残留检查：块内若还有没被解析的 `key:` 条目 → 说明写法超出了本解析器支持范围
    const leftovers = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(l))
        .filter((l) => {
            VALUE_RE.lastIndex = 0;
            return !VALUE_RE.test(l);
        });
    if (leftovers.length > 0) {
        throw new Error(
            'theme.js: ' + name + ' 中有无法解析的条目（只支持 单引号 hex 或 数字 字面量）:\n  ' +
            leftovers.join('\n  '),
        );
    }
    if (Object.keys(out).length === 0) {
        throw new Error('theme.js: ' + name + ' 解析结果为空');
    }
    return out;
}

function load() {
    const src = readSource();
    const theme = { hex: {}, num: {} };
    for (const n of HEX_BLOCKS) theme[n] = parseBlock(src, n, 'hex');
    for (const n of NUM_BLOCKS) theme[n] = parseBlock(src, n, 'num');
    return theme;
}

const T = load();

/** 反查：hex → 令牌名（主题合规校验用）。 */
const PALETTE_NAMES = {};
for (const [k, v] of Object.entries(T.PALETTE)) PALETTE_NAMES[v.toUpperCase()] = 'PALETTE.' + k;
const BOARD_NAMES = {};
for (const [k, v] of Object.entries(T.BOARD)) BOARD_NAMES[v.toUpperCase()] = 'BOARD.' + k;

/** 允许在设计系统里出现的所有 hex（页面用色）。 */
const ALLOWED_HEX = new Set([...Object.keys(PALETTE_NAMES), ...Object.keys(BOARD_NAMES)]);

/** 某 hex 是否来自令牌表；返回令牌名或 null。 */
function tokenNameOf(hex) {
    if (!hex) return null;
    const key = hex.toUpperCase();
    return PALETTE_NAMES[key] || BOARD_NAMES[key] || null;
}

module.exports = {
    PALETTE: T.PALETTE,
    BOARD: T.BOARD,
    RADIUS: T.RADIUS,
    SPACE: T.SPACE,
    FONT: T.FONT,
    LAYOUT: T.LAYOUT,
    ALLOWED_HEX,
    tokenNameOf,
    reload: load,
};

// 允许直接 `node tools/theme.js` 打印令牌，便于人工核对
if (require.main === module) {
    console.log('--- UITheme.ts 令牌（来自 assets/scripts/config/UITheme.ts）---');
    for (const n of ['PALETTE', 'BOARD', 'RADIUS', 'SPACE', 'FONT', 'LAYOUT']) {
        console.log('\n[' + n + ']');
        for (const [k, v] of Object.entries(T[n])) console.log('  ' + k.padEnd(14) + v);
    }
}