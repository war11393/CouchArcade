# UI 设计规范（白底扁平简约）

> **⚠️ 当前尺寸方案状态：未验证（UNVERIFIED）** —— 竖版机型自适应改造
> （`wechat-phase2-unverified` 标签已前移至包含本改动的提交）自动校验全绿
> （typecheck / 场景校验 / 单测），但**真机与微信开发者工具从未运行过**：
> Widget 落位、安全区避让、棋盘重算均属推断，需在 Creator 重新构建
> （build 产物不随源码自动更新）后到真机验证。
>
> 本文是**统一 UI 风格的唯一说明文档**。任何界面改动请先读本文，再改代码。
>
> 令牌唯一来源：`assets/scripts/config/UITheme.ts`
> 布局唯一来源：`tools/ui-trees.js`（4 个场景的静态节点树）
> 尺寸适配唯一来源：`assets/scripts/core/PortraitAdapter.ts`（见 §3.0）
> 校验：`node tools/validate-scenes.js`（含设计令牌合规 + 路径契约断言）

---

## 1. 设计方向

| 维度 | 决定 | 理由 |
| :--- | :--- | :--- |
| 底色 | **纯白 `#FFFFFF`** | 白底最耐看、最不容易脏；两款棋盘都是浅色，页面必须让位 |
| 风格 | **扁平 + 简约** | 无渐变、无投影、无高光；零美术资源也能做出整洁界面 |
| 层次手段 | **1px 细边 + 间距 + 留白** | 不用阴影就意味着必须靠边线与留白划分层次 |
| 主色 | 单一蓝色 `#2F6BFF` | 一个主色 + 语义色足够；多色会显得廉价 |
| 圆角 | 卡片 24 / 按钮 16 / 胶囊（按高一半） | 大圆角柔化白底的"硬"，但不过度 |
| 字号 | 6 级（56/42/32/28/24/20） | 禁止在业务代码里写魔法字号 |

---

## 2. 设计令牌（`UITheme.ts`）

### 2.1 色板 `PALETTE`

| 令牌 | 值 | 用途 |
| :--- | :--- | :--- |
| `bg` | `#FFFFFF` | 页面底（每屏 `Bg` 节点） |
| `surface` | `#FFFFFF` | 卡片 / 顶部栏 / 操作栏底 |
| `surfaceAlt` | `#F6F7F9` | 次级容器（取消按钮、分组底） |
| `sunken` | `#EFF1F5` | 沉底（进度条槽） |
| `border` | `#E6E8EC` | **1px 细边 / 分隔线（扁平风格的核心）** |
| `primary` | `#2F6BFF` | 主按钮、可点击、选中 |
| `primarySoft` | `#EAF0FF` | 主色淡底（弹窗选项、标签底） |
| `success` | `#12B76A` | 成功 / 我方得分 / 已准备 |
| `warn` | `#F79009` | 警告 / 机头 / VS 提示 |
| `danger` | `#F04438` | 失败 / 对手得分 / 危险操作文字 |
| `dangerSoft` | `#FDECEA` | 危险按钮底（不用实心红） |
| `accent` | `#7B61FF` | 辅助色（第二款游戏标识） |
| `ink` | `#1A1D24` | 一级文字（标题） |
| `inkSoft` | `#5A6272` | 二级文字（正文/说明） |
| `inkFaint` | `#98A0AE` | 三级文字（占位/页脚） |
| `onPrimary` | `#FFFFFF` | 主色底上的文字 |
| `toastBg` | `#22262F` | Toast 深色胶囊（浅色界面里对比最稳） |
| `overlay` | `#10131A` | 蒙层基色（配 alpha 120~140） |

### 2.2 棋盘色 `BOARD`

五子棋：白底 `#FFFFFF` + 浅灰网格 `#D8DDE4` + 星位 `#3B4250`；黑子 `#22262F`、白子 `#FFFFFF`（1px 边 `#C9D0DA`）；最后一手 `#F04438`；获胜连线 `#F79009`。

寻机头：棋盘底 `#FFFFFF` + 网格 `#DFE3E9`；未翻 `#F1F3F7`、空格 `#FFFFFF`、机身 `#2F6BFF`、机头 `#F79009`（格内符号统一白色）。

### 2.3 其他

```
RADIUS = { sm: 8, md: 16, lg: 24, pill: 999 }   // pill 由代码按高/2 夹取
SPACE  = { xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 }
FONT   = { display: 56, h1: 42, h2: 32, body: 28, sub: 24, caption: 20 }
LAYOUT = { designW: 720, designH: 1280, gutter: 32, headerH: 152,
           cardRadius: 24, cardW: 656, btnH: 88, btnRadius: 16, rowGap: 24, dividerH: 2 }
```

---

## 3. 布局栅格（4 屏共用）

### 3.0 尺寸模型（竖版自适应，v2）

设计分辨率**不再固定** 720×1280，而是「固定宽度基准 + 按机型实算高度」：

```
designW = 720（常量，宽度基准）
designH = round(720 × 屏幕高/屏幕宽)   ← 运行期由 PortraitAdapter 重算
view.setDesignResolutionSize(designW, designH, FIXED_WIDTH)
```

由此得到两条**书写坐标的铁律**：

1. **贴边件一律用 Widget，禁止写死 y**
   顶栏/底栏/背景改用 `cc.Widget` 锚定 Canvas 边缘
   （`ui-trees.js` 的 `topBarNode` / `bottomBarNode` / `fullBleedNode`）。
   任何 `y = DESIGN_H/2 - ...`、`y = -600` 这类写法在长屏上都会浮到半空。
   贴边条的 Widget 顶/底间距在运行期被 `PortraitAdapter.applyEdgeInsets()`
   改写成安全区避让值（躲刘海 / Home 条）；背景类（上下同贴）**不避让**，
   必须连刘海区一起铺满。
2. **中部内容件以「可视区中心」为原点书写，允许 ± 少量漂移**
   短屏（如 16:9，designH≈1280）下它们与旧版像素级一致；
   长屏下上下留白自然变大，而不是内容错位。

Canvas 中心为原点（`y=±designH/2` 顶/底边）。下表里的 `y=+640 / y=-640`
只在 720×1280 基准机型上成立。

```
┌──────────────────────────────────────────┐ y=+designH/2（Widget 贴顶 + 安全区避让）
│ Header  720×152                          │  白底 + 底部 1px 分隔线
│  ├─ 标题：左对齐，距左边框 32px           │  h1 42 bold / ink
│  └─ 辅助信息：右对齐，距右边框 32px       │  sub 24 / inkFaint
├──────────────────────────────────────────┤
│ 主内容区  左右留白 32px → 内容宽 656px     │
│  卡片：白底 + 1px 边 + 圆角 24            │
│  行间距：24px                             │
├──────────────────────────────────────────┤
│ 底部操作区：按钮高 88px（≥44pt 热区）      │
├──────────────────────────────────────────┤ y=-designH/2（Widget 贴底 + 安全区避让）
│ 页脚：caption 20 / inkFaint（96 高贴底条） │
└──────────────────────────────────────────┘
```

固定量（不要再自己算）：`gutter=32`、`headerH=152`、`cardW=656`、`btnH=88`、`rowGap=24`、`dividerH=2`。

### 各屏结构

| 屏 | 结构（自顶向下） |
| :--- | :--- |
| **Loading** | 品牌方块(168, primary, 圆角24) → 标题(display) → 副标题 → 进度条槽 480×12 胶囊 → 状态 → 版本号 |
| **Lobby** | Header → 游戏列表 ScrollView(view 656×840，content = 卡片列) → 页脚 |
| **Room** | Header(标题+房间号) → 座位卡×2(656×200，左侧 6px 色条) → VS → 状态 → 主按钮 + 次按钮(300×92) |
| **Game** | HUD 720×220(对手行/我方行/状态行 + 底部分隔线) → 棋盘卡 656×656 → 表情面板(默认隐藏) → 操作栏 720×168(3×200×84) |

---

## 4. 组件规范

| 组件 | 规范 | 实现 |
| :--- | :--- | :--- |
| **页面底** | 纯白，全屏 | `Bg` 节点 + `UiFill`(bg) |
| **卡片** | 白底 + `border` 1px + 圆角 24 | `cardNode()` → `UiFill` |
| **主按钮** | 主色实心 + 白字，圆角 16 | `buttonNode(..., 'primary')` |
| **次按钮** | 白底 + 1px 边 + ink 字 | `buttonNode(..., 'secondary')` |
| **危险按钮** | `dangerSoft` 底 + `danger` 字（**不用实心红**） | `buttonNode(..., 'danger')` |
| **分隔线** | 2px（视觉约 1 物理像素）`border` 色，通栏 | `dividerNode()` |
| **图标块** | 112×112，圆角 16，纯色 + 白色首字 | `Icon` 节点，颜色来自 `GameList.iconColor` |
| **文字层级** | 标题 ink / 正文 inkSoft / 辅助 inkFaint | 只用这三档灰阶 |
| **胶囊** | 圆角 = 高度/2（进度条、Toast） | `radius: RADIUS.pill` |
| **弹窗** | 白底卡片 + 蒙层 `overlay` alpha 120~140 | `createCard()` + `overlayColor()` |
| **Toast** | 深色胶囊 + 白字（错误/警告用语义色胶囊） | `UIManager._showToast()` |

### 文案长度约束

卡片描述列宽 320px、字号 22px → **单行 ≤14 个全角字符**（超长会被 CLAMP 截断）。
`GameList.desc` 必须遵守；新增游戏时按此裁剪文案。

---

## 5. 代码落地约定

1. **改 UI = 改 `tools/ui-trees.js`**，然后 `node tools/gen-scenes.js && node tools/validate-scenes.js`。
2. **颜色/圆角/间距/字号一律取令牌**（`ui-trees.js` 通过 `tools/theme.js` 解析 `UITheme.ts`），
   `ui-trees.js` 里**不允许出现 hex 字面量**（校验脚本会因"非令牌色"失败）。
3. **静态色块必须用 `UiFill`**（`assets/scripts/core/UiFill.ts`）：
   `cc.Graphics` 只序列化颜色、**不序列化绘制路径**，直接写进 `.scene` 是空组件 → 什么都不显示。
4. **控制器只按路径绑定节点**（`setLabelText/bindClick/fillAt/findNode`），不得运行时重建 UI。
   节点名是**契约**：`validate-scenes.js` 的路径契约断言会在改名时报错。
5. **UITheme.ts 的令牌块必须保持字面量形式**：
   `export const PALETTE = { key: '#RRGGBB', ... } as const;`（值为单引号 hex 或数字）。
   写成表达式/嵌套对象会让 `tools/theme.js` 解析失败（会直接抛错，不会静默用错色）。
6. `as const` 令牌是字面量类型，函数默认参数上会退化成字面量类型 →
   `createLabel(fontSize: number = FONT.body)` 这类参数要**显式标注 `number`**。

---

## 6. 新增一屏 / 新增游戏图标的标准动作

```
1) tools/ui-trees.js 里加/改节点树（用 fillNode/cardNode/textNode/buttonNode/dividerNode）
2) 若新增脚本组件：确认 .ts 有 .meta → node tools/extract-script-uuids.js（会自校验）
3) node tools/gen-scenes.js && node tools/validate-scenes.js
4) 在 validate-scenes.js 的 REQUIRED_PATHS 补上控制器要绑定的路径
5) cmd /c typecheck.cmd && node tools/test-core.js
6) 编辑器里删 library/ temp/ 重新导入，人工过一遍 docs/SELF_TEST_CHECKLIST.md 第 5.4 节
```

---

## 7. 常见坑（都踩过）

| 现象 | 根因 | 处理 |
| :--- | :--- | :--- |
| 场景里"只有文字、没有色块" | 静态节点用了 `cc.Graphics`（路径不序列化） | 换成 `UiFill` |
| 编辑器层级里看不到组件 | UI 只在运行时 `new Node()` 创建，没写进 `.scene` | UI 静态化进 `ui-trees.js` |
| 列表不能滚动 | `ScrollView.content` 被写成整棵节点描述（`__id__` 非数字） | 用 `nodeRef()`；校验断言会拦住 |
| 白底上文字看不见 | 从深色主题搬过来的白字 | 用令牌 `ink/inkSoft/inkFaint` |
| 白色卡片糊在一起 | 忘了 1px 边或间距 | 卡片必须带 `borderHex: C.border` |
| UI 改了但控制器不生效 | 节点名被改（路径契约破坏） | 跑 `validate-scenes.js` 看路径契约断言 |
| 白色卡片边框出现缺口 | 棋盘底板（bg）外扩 pad 超出父卡片，把 1px 描边盖掉 | 用 `BoardBase.innerMargin()` 夹取 pad（见两套棋盘的 draw()） |
