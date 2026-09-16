# 场景编辑器空白 / 预览全黑 — 修复报告

**日期**：2026-09-11
**Cocos Creator**：3.8.8

---

## 症状演进与四轮修复

| 轮次 | 症状 | 根因 | 是否命中 |
| :--- | :--- | :--- | :--- |
| 1 | 场景打不开 / 预览全黑 | `.scene` 序列化格式 4 类错误 | ✅ |
| 2 | 能进但报 `Cannot read ... getSystemInfo` | ServiceLocator 未注入 | ✅ |
| 3 | **层级管理器看不到任何组件** | **UI 只在运行时创建，没写进 `.scene`** | ✅ |

> ⚠️ 第 1 轮的一份早期报告（同日期）把原因写成"AppConfig 枚举顺序 + 缓存"，
> **未命中根因**（typecheck 自始至终通过）。已作废。

---

## 第 1 轮：`.scene` 序列化格式（4 类）

### ① `__id__` 是【数组下标】，不是随手编的引用号 —— 主因

`.scene` 是紧凑 JSON 数组，元素间按**数组下标**互引。
原先把 `cc.SceneGlobals` 放在 index 10 却写成 `_globals -> 99`、子信息 `100..106`，
全部越界 → `data[99] === undefined` → 场景加载即失败。**修正 32 处**。

对照官方参考场景（唯一 ground truth）：
```
<Creator>/resources/resources/3d/engine/editor/assets/default_file_content/scene/scene-2d.scene
SceneGlobals 位于 INDEX 8 → cc.Scene._globals 写 {"__id__": 8}
```

### ② 节点/组件 `_id` 必须是 22 位压缩 uuid

```jsonc
"_id": "8b421327-008b-4421-a8b4-8b421327008b"   // ❌ 36 位，编辑器解析不了
"_id": "EA1ekOKwuZl9px9MMsPkTd"                 // ✅ 22 位 base64
```
例外：**`cc.Scene._id` 保持 36 位**（= 场景资源 uuid，与 `.scene.meta` 的 `uuid` 一致）。

### ③ Camera 节点在 DEFAULT 层

| 节点 | `_layer` |
| :--- | :--- |
| Camera | `1073741824` (1<<30 DEFAULT) |
| Canvas / UI 节点 | `33554432` (1<<25 UI_2D) |

相机 `_visibility = 41943040` (UI_2D\|UI_3D)。

### ④ 脚本组件的 `__type__` 必须是【脚本压缩 uuid】，不是 `@ccclass` 名

```jsonc
"__type__": "LobbyScene"              // ❌ 编辑器报 Missing class: LobbyScene
"__type__": "137f0Ya7/NKx7CZ+fqyuKkN" // ✅ 脚本压缩 uuid
```

**权威值获取**（不要自己猜压缩算法，实测手写实现与编辑器结果不符）：
```powershell
node tools\extract-script-uuids.js   # 从编译产物 _RF.push 提取 → script-uuids.json
```

### 附带：渲染管线

`custom-pipeline` → 内置管线 `builtin-pipeline`（2D 项目正确值，且引擎模块已裁掉 3d）。

---

## 第 2 轮：ServiceLocator 从未被注入

```
TypeError: Cannot read properties of undefined (reading 'getSystemInfo')
    at SafeAreaAdapter.apply (SafeAreaAdapter.ts:83)
    at LobbyScene._buildUI (LobbyScene.ts:70)
```

`AppBootstrap`（负责调用 `services.init()`）**没有被挂到任何场景**，也没被任何代码 import
—— 是死代码。`LoadingScene` 里恰好有临时兜底所以能跑，`LobbyScene` 没有兜底，一跳转就崩。

### 修复

1. `ServiceLocator` 新增幂等 `ensureServices()` + `inited` getter；
2. 四个场景控制器 `onLoad` **第一行**调用 `ensureServices()`；
3. 加固 `SafeAreaAdapter`：`ensureServices()` + `_readSystemInfo()`（try/catch + 数据校验），
   失败时降级为全屏布局而非抛异常白屏。

---

## 第 3 轮：UI 从未写进 `.scene`（层级管理器看不到组件的根因）

### 症状

```
Lobby 层级：Canvas → [SceneRoot, Camera]     仅此而已，没有任何 Label 等
```

### 根因

UI 全部由脚本在 `onLoad` 里用 `new Node()` / `createLabel()` / `addChild()`
**运行时现造**。这些节点不会写回 `.scene` 文件，
所以层级管理器里**永远看不到** —— 场景文件本身就是个空壳。

**这是我前期最大的判断失误**：看到 `SceneRoot._children === []` 时，
我用"反正脚本会运行时构建"来解释，而**没有验证这个假设**。事实是：
能否加载（格式对不对）与有没有内容（UI 在不在场景里）是两件事。

### 修复：UI 改为静态节点

新增两个工具，把 UI 声明式地编译进 `.scene`：

| 文件 | 作用 |
| :--- | :--- |
| `tools/scene-builder.js` | 节点树 → `.scene` 序列化数组的编译器（两遍构建 + 引用回填 + 自检） |
| `tools/ui-trees.js` | 4 个场景的 UI 节点树声明（Label/Graphics/ProgressBar/ScrollView/Layout/Mask/Button） |

**修复后的层级结构**（编辑器里现在能看到的）：

```
Loading
 └─ Canvas  [cc.Canvas, cc.UITransform, cc.Widget]
     ├─ Bg            [cc.Graphics]
     ├─ Title         [cc.Label]
     ├─ Subtitle      [cc.Label]
     ├─ ProgressBarBg [cc.Graphics, cc.ProgressBar]
     │   └─ ProgressBarFill [cc.Graphics]
     ├─ Status        [cc.Label]
     ├─ Version       [cc.Label]
     ├─ SceneRoot     [LoadingScene]
     └─ Camera        [cc.Camera]

Lobby
 └─ Canvas  [cc.Canvas, cc.UITransform, cc.Widget]
     ├─ Bg            [cc.Graphics]
     ├─ Header        [cc.Graphics]
     │   ├─ HeaderTitle [cc.Label]
     │   └─ HeaderUser  [cc.Label]
     ├─ GameList      [cc.ScrollView]
     │   └─ view      [cc.Mask]
     │       └─ content [cc.Layout]
     │           ├─ Card_planehunt [cc.Graphics]
     │           │   ├─ Icon [cc.Graphics] └─ IconText [cc.Label]
     │           │   ├─ Name / Desc / Online [cc.Label]
     │           │   └─ PlayBtn [cc.Button] └─ PlayBtnLabel [cc.Label]
     │           └─ Card_gomoku  （同上）
     ├─ Footer        [cc.Label]
     ├─ SceneRoot     [LobbyScene]
     └─ Camera        [cc.Camera]

Room
 └─ Canvas
     ├─ Bg / Header [cc.Graphics]  ├─ RoomTitle / RoomId [cc.Label]
     ├─ SeatTop / SeatBottom [cc.Graphics]  └─ SeatName / SeatStatus / SeatScore [cc.Label]
     ├─ VsLabel [cc.Label]   ├─ Status [cc.Label]
     ├─ BtnReady / BtnLeave [cc.Button] └─ *Label [cc.Label]
     ├─ SceneRoot [RoomScene] └─ Camera [cc.Camera]

Game
 └─ Canvas
     ├─ Bg / Hud [cc.Graphics]
     │   └─ OppName / OppScore / MyName / MyScore / TurnLabel / TimerLabel [cc.Label]
     ├─ BoardArea [cc.Graphics] └─ BoardHint [cc.Label]
     ├─ EmotePanel [cc.Graphics] └─ EmoteList [cc.Label]
     ├─ ActionBar [cc.Graphics]
     │   └─ BtnEmote / BtnRestart / BtnLeaveGame [cc.Button] └─ *Label [cc.Label]
     ├─ SceneRoot [GameScene] └─ Camera [cc.Camera]
```

### 脚本改为「绑定」而非「重建」

`UIFactory` 新增绑定工具，控制器不再创建 UI：

```ts
findNode(from, 'Canvas/Header/HeaderUser')   // 按路径查节点
requireNode(from, path)                      // 必需节点，缺失抛错
labelAt(from, path)                          // 取 Label 组件
bindClick(from, path, cb)                    // 绑按钮点击
setLabelText(from, path, '新文案')            // 安全设值（缺失只告警）
```

**保留运行时创建的只有真正动态的浮层**：Toast、模式选择弹窗、结算弹窗
（内容随选择变化，不适合静态化），已在代码注释里说明原因。

---

## 编译器实现要点（三个坑，都踩过）

1. **`__id__` 是下标 → 必须两遍构建**
   先建全部对象并记录「描述对象 → 下标」，再回填 `_children`/`_components`/`_parent`。
   一边 push 一边写引用必然错位。

2. **组件声明必须归一化**
   `makeNode` 的 comps 既可能收到 `{type, body}`，也可能收到已构造的
   `{__type__: 'cc.UITransform', ...}`。不归一化 → `comp.type` 为 `undefined`
   → 生成出「没有 `__type__` 的组件对象」。已加 `normalizeComp()`。
   *（这个 bug 是被自己的校验器抓出来的 —— `_components 指向无效对象`。）*

3. **每个节点至多一个 `UITransform`**
   若 `makeNode` 的 `size` 参数会自动加一个，就不要再显式传。
   重复会冲突。已在校验里加断言。

---

## 验证（全部真实执行）

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| 场景结构 + 内容校验 | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 严格类型校验 | `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| 纯逻辑单测 | `node tools/test-core.js` | ✅ `40 通过, 0 失败` |
| 生成器确定性 | 连续两次 `gen-scenes.js` | ✅ 输出完全一致 |
| 节点树导出 | 见上方结构图 | ✅ 4 场景共 80 节点 |

### `validate-scenes.js` 断言分两层

**A. 格式正确性**：无越界/悬空 `__id__`、所有对象有 `__type__`、
`_id` 位数、无重复 `_id`、层与相机、父子/组件指针双向一致、
无重复 `UITransform`、SceneGlobals 引用、脚本 uuid 权威值一致、`ensureServices()` 已调用。

**B. 内容存在性（关键补充）**：
每个场景必须具备的视觉组件（如 Lobby 需 `cc.Label ≥ 8`、`cc.ScrollView ≥ 1`、
`cc.Layout ≥ 1`、`cc.Mask ≥ 1`、`cc.Button ≥ 2`）；
Canvas 下有 ≥2 个 UI 子节点（**防空壳**）；
所有 Label 有非空 `_string` 且 `_color.a > 0`（否则不可见）；
所有节点有名字。

> **教训**：校验必须能证明「目标达成」，而不只是「格式合法」。
> 之前 36 项全过但场景是空壳 —— 因为校验只看格式，不看有没有内容。
> "校验通过"被误当成"问题解决"，代价是多绕了一轮。

---

## 工具总览（`tools/`）

| 文件 | 作用 |
| :--- | :--- |
| `scene-builder.js` | 节点树 → `.scene` 编译器（两遍构建 + 自检） |
| `ui-trees.js` | 4 场景 UI 节点树声明（**改 UI 改这里**） |
| `gen-scenes.js` | 生成 4 个 `.scene` + `scenes.meta` |
| `validate-scenes.js` | **回归校验**，改场景/UI 后必跑 |
| `extract-script-uuids.js` | 提取脚本压缩 uuid → `script-uuids.json` |
| `script-uuids.json` | 脚本压缩 uuid 权威表 |
| `fix-scenes.js` / `fix-scene-globals.js` / `fix-scene-script-types.js` | 一次性修复器（已完成使命） |

### 日常改动流程

```powershell
# 1. 改 UI → 编辑 tools/ui-trees.js
# 2. 重新生成
node tools\gen-scenes.js
# 3. 校验
node tools\validate-scenes.js     # 期望 ALL_SCENE_VALIDATIONS_PASSED
# 4. 类型 + 单测
cmd /c typecheck.cmd
node tools\test-core.js
# 5. 让编辑器重新导入
Remove-Item -Recurse -Force library, temp
```

---

## 请你验证

重新打开项目（`library/`、`temp/` 已清空，会重新导入），然后：

1. 双击 `assets/scenes/Lobby.scene`
   → 层级管理器应出现 **Canvas 下的 Bg / Header / GameList / Footer / SceneRoot / Camera**，
     展开 `GameList → view → content` 能看到两张 **Card_planehunt / Card_gomoku**，
     再展开可看到 `Icon / Name / Desc / Online / PlayBtn` 等带 **Label / Button** 图标的节点
2. 点场景视图 → 应看到深色背景 + "游戏大厅" 标题 + 两张游戏卡片 + "开始游戏" 按钮
3. 点预览 → Loading 进度条走完后跳进大厅，能看到卡片与按钮

**仍未被我验证的部分**（诚实说明）：我无法在编辑器里实际渲染，
以上是基于文件结构的构造与断言。像素级效果（配色、文字大小、位置是否美观）
需要你亲眼看。

若仍看不到内容，请提供：编辑器**控制台**日志、以及层级管理器的**截图**。

---

## 第 4 轮：点击「开始游戏」没反应（弹窗不可见）

**日期**：2026-09-15

### 症状

```
[LobbyScene] 选择游戏：寻机头                             ← 点击链路正常
[UIManager] 模式选择弹窗已显示：寻机头（父节点=Overlay）   ← 弹窗节点已创建
[UIManager] 弹窗诊断已显示（AppConfig.SHOW_DIALOG_DEBUG=true）
```
控制台一切正常，**但屏幕上一个像素都没有变化** —— 连铺满全屏的诊断面板都看不见。

### 根因：浮层容器 `Overlay` 没有 `UITransform`

为修复「弹窗挂 Canvas 会被 ScrollView 的 Mask 影响」，新增了 `Canvas/Overlay`
浮层容器，并把它写成了**零组件的裸节点**（当时的理由：容器不需要自己的尺寸）。

结果：**整棵子树完全不可见**。Cocos 3.x 的 UI 渲染依赖父节点的
`UITransform` 参与世界变换与渲染批次计算，缺少 `UITransform` 的中间节点
会让子节点的位置/裁剪失效。

这个 bug 的危险之处在于**所有常规断言都通过**：节点存在、`active=true`、
`scale=1`、`alpha=255`、尺寸>0、兄弟序号正确 —— 但就是看不见。
只有「屏幕上看一眼」或「驱动真实渲染」才能发现。

### ⚠️ 我上一轮的诊断是错的（记录以免重犯）

第一次修复时我把根因写成「弹窗被 `GameList` 的 Mask 裁掉」，并据此写了文档和断言。
**读完引擎源码后该理论被证伪**，三条都站不住：

| 曾怀疑 | 引擎实际行为 | 源码位置 |
| :--- | :--- | :--- |
| `cc.Button` 吞掉 `TOUCH_END` | `propagationStopped` 只截断**冒泡**；`AT_TARGET` 阶段同节点所有监听器照常触发 | `node-event-processor.ts:290-292` |
| `ScrollView.cancelInnerEvents` 吞掉点击 | 官方注释明确：**只有真的发生滚动**才取消，短按的 touchend 不受影响 | `scroll-view.ts:402-414` |
| 按钮被 Mask 裁剪掉 | 几何计算：卡片中心 y=-100，view 裁剪区 -420..+420，完全在内 | `tools/ui-trees.js` |

教训：**「节点创建成功 + 屏幕无变化」时应优先怀疑渲染层的基础组件缺失
（UITransform / Renderer），而不是继续在「谁吞了事件」上推理。**
更关键的教训是：**不要把自己的推测当成已验证的结论写进文档。**
第一轮我用「Mask 裁剪」这个未证实的推断去改代码，反而制造了新的 bug。

### 修复

| 位置 | 改动 |
| :--- | :--- |
| `tools/ui-trees.js` → `overlayNode()` | 挂上**全屏 `UITransform`（720×1280，居中锚点）**，让子节点坐标语义与 Canvas 一致 |
| `tools/gen-scenes.js` | Canvas 子节点顺序：`UI… → SceneRoot → Overlay → Camera`（浮层为最后一个 UI_2D 节点） |
| `assets/scripts/core/UIManager.ts` | `_overlayRoot()` 统一承载 Toast / 模式弹窗 / 结算弹窗；两个蒙层补 `BlockInputEvents` |
| `tools/validate-scenes.js` | **更正**上一轮的错误断言：从「Overlay 是纯容器（无任何组件）」改为「恰好 1 个 UITransform + 正尺寸 + 不含 Mask/Graphics」 |

> 上一轮那条「无任何组件」的断言实际上**把 bug 保护了起来** —— 它让错误写法
> 通过了校验。断言必须能证伪目标，否则就是自我安慰（这与第 3 轮的教训同源）。

### 本轮验证

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| 场景结构（含 Overlay 新断言） | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 严格类型校验 | `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| 纯逻辑单测 | `node tools/test-core.js` | ✅ `40 通过, 0 失败` |

**仍需真人确认**（我无法渲染）：预览里点「开始游戏」应出现半透明蒙层 + 居中
模式选择面板；`AppConfig.SHOW_DIALOG_DEBUG` 的深色诊断面板应可见。
确认无误后把该开关改回 `false`。

---

## 第 5 轮：微信小游戏「明确的加载页」

**日期**：2026-09-15

### 为什么这是必需项（不是可选装饰）

原 Loading 场景只有「标题 + 细进度条 + 一行『初始化中…』」，
**没有百分比数字、没有阶段文案、没有更新提示、没有卡住兜底**。

小游戏冷启动要先下载代码包 + 初始化引擎，这段时间屏幕本来是空的 ——
没有明确反馈就是「无响应」观感（微信侧审核/体验的硬要求）。

### 加载页构成

| 元素 | 作用 |
| :--- | :--- |
| `ProgressText`（大号 `0%`） | **明确进度反馈**（微信要求的核心可视元素） |
| `Status` | 阶段文案：初始化 → 加载资源 → 登录 → 云服务 → 检查更新 |
| `Hint` | 卡住兜底：「加载较慢，请检查网络后重试」（停滞 > 8s 才显示） |
| `ProgressBarBg/Fill` | 进度条（`scale.x` 驱动 + 同步 `cc.ProgressBar`） |
| `Version` | `v0.1.0 \| 微信真机模式 \| 720x1280`（版本号统一取 `AppConfig.APP_VERSION`） |

配套代码改动：

- `LoadingScene.ts` 重写：按**阶段权重**（BOOT .15 / RESOURCE .35 / LOGIN .25 /
  CLOUD .15 / UPDATE .10）推进真实进度，`_advance()` 保证**只增不减**
  （回退会让用户误以为卡死）；
- 新增 `IPlatformService.checkUpdate?()` 契约 + `WxPlatformService.checkUpdate()` 桩
  （`wx.getUpdateManager` 三回调）+ `MockPlatformService.checkUpdate()`；
- 更新提示做成**选项弹窗**（「立即重启更新 / 稍后再说」）—— 小游戏**不支持强制更新**；
- 启动失败时把 `Hint` 变成可点重试入口，避免用户卡死在加载页。

**验收要点**：起始场景必须是 `Loading`（构建面板 → 起始场景），否则加载页不会运行。

---

## 第 6 轮：运行时 UI 节点全在 DEFAULT 层（点击「开始游戏」没反应 · 真因）

**日期**：2026-09-16

### 症状

第 4 轮修好 `Overlay` 的 `UITransform` 之后，**症状完全没变**：

```
[LobbyScene] 选择游戏：寻机头                             ← 点击链路正常
[UIManager] 模式选择弹窗已显示：寻机头（父节点=Overlay）   ← 节点创建成功
[UIManager] 弹窗诊断已显示（AppConfig.SHOW_DIALOG_DEBUG=true）
```

控制台正常，屏幕上依然**一个像素都没变**，连铺满全屏的深色诊断面板也看不见。

### 根因：`new Node()` 的默认 layer 是 DEFAULT，不在相机可见性掩码内

| 常量 | 值 | 二进制 |
| :--- | :--- | :--- |
| `Layers.Enum.DEFAULT`（`new Node()` 默认） | 1073741824 | `1<<30` |
| `Layers.Enum.UI_2D`（静态场景节点用的） | 33554432 | `1<<25` |
| 相机 `visibility`（四个场景实测） | 50331648 | `1<<25 \| 1<<24` |

`50331648 & 1073741824 === 0` —— **DEFAULT 层的节点对 UI 相机完全不可见**，
而且**不参与 UI 事件命中测试**。所以运行时创建的一切（Toast / 模式弹窗 /
结算弹窗 / 诊断面板 / 棋盘棋子）既不显示、也点不到。

静态 `.scene` 节点之所以正常，是因为 `tools/scene-builder.js` 的 `makeNode()`
写死了 `layer = LAYER_UI_2D`；而 `assets/scripts/core/UIFactory.ts` 里的
`createRect/createLabel/createButton` 全都用裸 `new Node()`，于是**集体踩坑**。
`addChild` **不会**让子节点继承父节点 layer，所以只改父节点没用。

### 与第 4 轮的对比（同一类坑的第二次）

两轮的**症状、误导性、验证方式完全一致**，这也是它值得单独立一轮的原因：

| | 第 4 轮 | 第 6 轮 |
| :--- | :--- | :--- |
| 缺失的东西 | 父节点 `UITransform` | 节点 `layer = UI_2D` |
| 常规断言（存在/尺寸/alpha/sibling） | 全通过 | 全通过 |
| 日志 | 全部正常 | 全部正常 |
| 唯一能发现的方式 | 真机看一眼 / 查引擎渲染条件 | 同左 |

**教训（比第 4 轮更具体）**：Cocos 3.x 里一个节点要「可见且可点」，
除了 `UITransform` 和 Renderer，还必须满足 **`(node.layer & camera.visibility) !== 0`**。
排查「节点建好了但屏幕没反应」时，这三条要**一起**查，而不是只查事件谁吞了。

### 修复

| 位置 | 改动 |
| :--- | :--- |
| `UIFactory.ts` | 新增并导出 `newUINode(name)`（内部 `layer = Layers.Enum.UI_2D`），**所有** `createRect / createLabel / createVerticalList / createAvatar` 改走它 |
| `UIFactory.ts` | 新增 `forceUILayer(node)`：递归校正整棵子树，用于预制体/第三方 `addChild` 兜底 |
| `UIManager.ts` | `_overlayRoot()` 增加断言式兜底：容器非 UI_2D 层时告警并强改，防止浮层容器被误改 |
| `UIManager.ts` | 诊断面板新增 **`layer=` 与 `相机可见=是/否`** 两行 —— 这一项本来就能一眼定位本轮 bug |
| `GomokuBoard.ts` / `PlaneHuntBoard.ts` | 棋盘内部 10 处 `new Node()` 全部改 `newUINode()`（棋子/网格/标记/连赢线是**对局中动态创建**的，只靠 GameScene 的 `forceUILayer` 兜不住） |
| `GameScene.ts` | 棋盘根节点显式设 layer，并在装配后 `forceUILayer(boardNode)` 兜底 |
| `tools/validate-scenes.js` | 新增 **D 节「运行时节点层级护栏」**：静态扫描 `assets/scripts/**/*.ts`，任何 `new Node()` 若未在 3 行内设置 `layer` 或调用 `forceUILayer` 即**校验失败** |

> 关键：护栏是**回归防护**，不是文档。第 4 轮的教训是「错误的断言会把 bug 保护起来」，
> 所以这次加的是能**证伪**的规则（没有它，下一轮又会有人直接 `new Node()`）。

### 配套：全链路日志（本轮按需求补）

| 阶段 | 日志前缀 |
| :--- | :--- |
| 点游戏卡片 | `[LobbyScene] 选择游戏：xxx` |
| 弹窗选项点击 | `[UIManager] 弹窗选项被点击：xxx` |
| 选创建/AI | `[LobbyScene] 选择「创建房间」→ gotoRoom(pvp)` |
| 场景切换 | `[UIManager] 切换场景 → Room（当前场景=Lobby）` |
| 进入房间 | `[RoomScene] onLoad 开始` / `收到进入参数：gameId/mode/joinRoomId` |
| 房间状态 | `[RoomScene] 房间状态更新：roomId/status/房主/isPractice/座位准备情况` |
| 开局判定 | `[RoomScene] 满足自动开局条件 → 触发 _onStart` → `_onStart：调用 startRoom…` → `startRoom 成功` → `进入对局场景（gameId/mode）` |

### 本轮验证

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| 场景结构 + **层级护栏** | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 严格类型校验 | `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| 纯逻辑单测 | `node tools/test-core.js` | ✅ `40 通过, 0 失败` |
| 护栏自身有效性 | 故意保留 board 里的 `new Node()` | ✅ 正确报 `FAILURES: 1`（能证伪） |

**仍需真人确认**（我无法渲染）：预览点「开始游戏」→ 应看到半透明蒙层 +
居中模式选择面板 + 深色诊断面板（其中 `mask.layer=33554432(UI_2D✓) 相机可见=是✓`）。
确认无误后把 `AppConfig.SHOW_DIALOG_DEBUG` 改回 `false`。

---

## 配置概览

| 参数 | 值 |
| :--- | :--- |
| 设计分辨率 | 720 × 1280（fitWidth=true, fitHeight=false） |
| 帧率 | 60 FPS |
| 启动场景 | `db://assets/scenes/Loading.scene` |
| 渲染管线 | 内置管线 `builtin-pipeline` |
| 引擎模块 | 已裁掉 3D / 骨骼动画 / 自定义管线 / WebGPU |
