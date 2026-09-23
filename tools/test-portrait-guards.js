/**
 * 竖版自适应「短屏护栏」数值仿真（check-all 第 5 层）。
 *
 * ⚠️ 这是**数值仿真**，不是运行时测试：它复刻 PortraitAdapter 的
 * 换算与三个控制器的护栏分支（改 PortraitAdapter/护栏逻辑时要同步这里，
 * 好在断言写的是行为契约：基准零改动 / 刘海平移 / 矮屏收缩不越界）。
 *
 * 对多档机型断言：
 *   ① 基准机型（16:9 → designH=1280）：所有护栏零改动（向后兼容的根保证）
 *   ② 长屏机型（19.5:9 / 20:9）：护栏零改动、贴边件由 Widget 处理
 *   ③ 刘海基准机：带子变窄 → 列表只平移不收缩
 *   ④ 矮屏机型（iPad 4:3 → designH=960）：护栏必须收缩且完整落在带内
 *   ⑤ 异常比例（<1.2）：退回基准比例，行为等同 ①
 */
const DESIGN_W = 720;
const DESIGN_H = 1280;
const ASPECT_MIN = 1.2;
const ASPECT_MAX = 2.6;
const FALLBACK_TOP = 44;
const FALLBACK_BOTTOM = 34;

function compute(sw, sh, sa) {
    // sa = 平台报告的原始安全区（逻辑px 边缘坐标，同 wx/Mock 口径）；null = 数据缺失
    let aspect = sh / sw;
    let abnormal = false;
    if (!isFinite(aspect) || aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
        abnormal = true;
        aspect = DESIGN_H / DESIGN_W;
    }
    let designH = Math.round(DESIGN_W * aspect);
    designH = Math.max(DESIGN_W, designH - (designH % 2 === 1 ? 1 : 0));
    const k = DESIGN_W / sw;
    let safeTop, safeBottom;
    if (sa && sa.right > sa.left && sa.bottom > sa.top) {
        safeTop = Math.max(0, Math.round(sa.top * k));
        safeBottom = Math.max(0, Math.round((sh - sa.bottom) * k));
    } else {
        safeTop = Math.round(FALLBACK_TOP * k);
        safeBottom = Math.round(FALLBACK_BOTTOM * k);
    }
    const maxTop = Math.max(0, designH - 200);
    if (safeTop > maxTop) safeTop = maxTop;
    if (safeBottom > maxTop) safeBottom = maxTop;
    return {
        designH, abnormal,
        safeTopY: designH / 2 - safeTop,
        safeBottomY: -designH / 2 + safeBottom,
    };
}
const FULL = (sw, sh) => ({ top: 0, left: 0, right: sw, bottom: sh }); // 无刘海：全屏安全区
const NOTCH = (sw, sh) => ({ top: 44, left: 0, right: sw, bottom: sh - 34 }); // 刘海+Home条

function band(L, reserveTop, reserveBottom) {
    return { top: L.safeTopY - reserveTop, bottom: L.safeBottomY + reserveBottom };
}

// —— 复制 LobbyScene 的列表护栏（含收缩语义，GameList/view 同步） ——
function lobbyList(L) {
    const b = band(L, 152, 96);
    let h = 840, cy = 44;
    const half = h / 2;
    const changed = cy + half > b.top || cy - half < b.bottom;
    if (changed) {
        const bandH = b.top - b.bottom;
        if (h > bandH) h = bandH;
        const nh = h / 2;
        cy = Math.min(Math.max(cy, b.bottom + nh), b.top - nh);
    }
    return { h, cy, changed, inside: cy + h / 2 <= b.top + 0.5 && cy - h / 2 >= b.bottom - 0.5 };
}

// —— 复制 fitNodeInBand（Game 棋盘/表情） ——
function fitNode(L, h, cy, rT, rB) {
    const b = band(L, rT, rB);
    const half = h / 2;
    if (cy + half <= b.top && cy - half >= b.bottom) return { h, cy, changed: false, inside: true };
    const avail = Math.max(120, b.top - b.bottom);
    h = Math.min(h, avail);
    const nh = h / 2;
    cy = h >= avail ? (b.top + b.bottom) / 2 : Math.min(Math.max(cy, b.bottom + nh), b.top - nh);
    return { h, cy, changed: true, inside: cy + h / 2 <= b.top + 0.5 && cy - h / 2 >= b.bottom - 0.5 };
}

// —— 复制 fitBlockInBand（Room 座位列：先平移，放不下按比例压缩） ——
function fitBlock(L, items, rT, rB) {
    let topEdge = -Infinity, bottomEdge = Infinity;
    for (const { h, cy } of items) { topEdge = Math.max(topEdge, cy + h / 2); bottomEdge = Math.min(bottomEdge, cy - h / 2); }
    const b = band(L, rT, rB);
    if (topEdge <= b.top && bottomEdge >= b.bottom) return { changed: false, inside: true, s: 1, items };
    const blockCenter = (topEdge + bottomEdge) / 2;
    const totalH = topEdge - bottomEdge;
    const bandH = b.top - b.bottom;
    const s = Math.min(1, bandH / totalH);
    const center = (b.top + b.bottom) / 2;
    const out = items.map((it) => ({ h: Math.max(24, Math.round(it.h * s)), cy: center + (it.cy - blockCenter) * s }));
    let t2 = -Infinity, b2 = Infinity;
    for (const it of out) { t2 = Math.max(t2, it.cy + it.h / 2); b2 = Math.min(b2, it.cy - it.h / 2); }
    // 列内两两不重叠（平移+等比压缩保持相对序，这里仍显式检查）
    let overlap = false;
    for (let i = 0; i + 1 < out.length; i++) {
        if (out[i].cy - out[i].h / 2 < out[i + 1].cy + out[i + 1].h / 2) overlap = true;
    }
    return { changed: true, inside: t2 <= b.top + 1 && b2 >= b.bottom - 1, s, items: out, overlap };
}

let fails = 0;
const t = (name, cond, detail) => {
    if (cond) console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`);
    else { fails++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

// iPad 竖屏：810x1080 逻辑px（4:3）；iPhone 12：390x844（≈19.5:9）
// 三星 S8 类 20:9：360x800；异常横屏数据：800x360
const cases = {
    base169: { L: compute(720, 1280, FULL(720, 1280)), desc: 'designH=1280 无刘海' },
    notch169: { L: compute(720, 1280, NOTCH(720, 1280)), desc: 'designH=1280 刘海' },
    ipad: { L: compute(810, 1080, NOTCH(810, 1080)), desc: 'designH=960' },
    iphone12: { L: compute(390, 844, NOTCH(390, 844)), desc: 'designH=1560' },
    s8: { L: compute(360, 800, NOTCH(360, 800)), desc: 'designH=1600' },
    abnormal: { L: compute(800, 360, FULL(800, 360)), desc: '横屏数据→兜底1280' },
};
const ROOM_COL = [{ h: 200, cy: 340 }, { h: 46, cy: 205 }, { h: 200, cy: 70 }, { h: 44, cy: -130 }];

console.log('=== 基准与长屏（无刘海）：护栏必须零改动（向后兼容根保证） ===');
for (const key of ['base169', 'iphone12', 's8']) {
    const { L, desc } = cases[key];
    const list = lobbyList(L);
    const board = fitNode(L, 656, -30, 248, 168);
    const block = fitBlock(L, ROOM_COL, 152, 200);
    t(`${key}(${desc}) 三护栏全部未触发`, !list.changed && !board.changed && !block.changed,
        `list=${JSON.stringify({ h: list.h, cy: list.cy })} board=${JSON.stringify({ h: board.h, cy: board.cy })}`);
}

console.log('=== 基准比例 + 刘海：带子被压窄，护栏收敛但不破坏内容 ===');
{
    const { L, desc } = cases.notch169;
    const list = lobbyList(L);
    // 刘海吃掉上下共 78 设计px：带子仍装得下 840 列表，但原 cy=44 顶到
    // 带子上沿外 ⇒ 护栏只平移、不收缩 —— 这正是要验证的收敛行为
    t(`Lobby 列表平移后入带且不收缩`, list.changed && list.inside && list.h === 840,
        `h=${list.h} cy=${list.cy}`);
    const board = fitNode(L, 656, -30, 248, 168);
    t(`Game 棋盘在刘海基准机仍零改动`, !board.changed);
    const block = fitBlock(L, ROOM_COL, 152, 200);
    t(`Room 座位列在刘海基准机放得下（顶边 440 ≤ 带沿 444）`, !block.changed);
}

console.log('=== 异常数据：退回基准比例，等同基准行为 ===');
{
    const { L, desc } = cases.abnormal;
    t(`abnormal(${desc}) 触发兜底标记`, L.abnormal && L.designH === 1280);
    const list = lobbyList(L);
    t('abnormal 护栏零改动', !list.changed);
}

console.log('=== 矮屏（iPad 竖屏 designH≈960）：护栏必须收缩且不越界 ===');
{
    const { L } = cases.ipad;
    const list = lobbyList(L);
    t(`Lobby 列表收缩后完整落在带内`, list.changed && list.inside,
        `h=${list.h} cy=${list.cy} band=${JSON.stringify(band(L, 152, 96))}`);
    const board = fitNode(L, 656, -30, 248, 168);
    t(`Game 棋盘收缩后完整落在带内`, board.changed && board.inside,
        `h=${board.h} cy=${board.cy}`);
    t(`棋盘收缩为正方向（≤原尺寸）`, board.h <= 656 && board.h > 0);
    const emote = fitNode(L, 96, -424, 248, 168);
    t(`表情面板拉回带内`, emote.changed && emote.inside, `cy=${emote.cy}`);
    const block = fitBlock(L, ROOM_COL, 152, 200);
    t(`Room 座位列压缩后完整落在带内`, block.changed && block.inside,
        `s=${block.s.toFixed(3)} 高=${block.items.map((i) => i.h).join('/')}`);
    t(`Room 座位列压缩后列内无重叠`, !block.overlap);
}

console.log(fails === 0 ? '\nALL_GUARD_SIMULATIONS_PASSED' : `\nGUARD_FAILURES=${fails}`);
process.exit(fails === 0 ? 0 : 1);
