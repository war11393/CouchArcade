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
| 相机 `visibility`（四个场景实测） | 50331648 | `1<<25 \| 1<<24 \| 1<<23` |

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

## 第 7 轮：AI 练习无法开局 + 寻机头点击无反应 + 弹窗/棋盘 UI

**日期**：2026-09-16

本轮是**四个独立问题**，其中两个是真 bug（会卡死流程），两个是 UI 调整。
两个 bug 都属于「看代码觉得很对、跑起来才发现」的类型，因此**先写复现脚本再改**
（见文末「方法」一节）。

### 7.1 AI 练习模式点进对局报「全员准备后才能开局」

**症状**：大厅选「AI 练习」→ 进 Room → `[RoomScene] AI 练习模式：跳过等待，准备开局`
→ 立刻 `[RoomScene] 开局失败: Error: 全员准备后才能开局`。

**根因**：`MockRoomService._refreshReadyStatus()` 是个**会把状态降级**的函数：

```typescript
const allReady = room.seats.every((s) => s.playerId !== '' && s.ready);
if (!allReady && room.status === RoomStatus.READY) {
    this._setStatus(RoomStatus.WAITING);   // ← 把已经 READY 的房打回 WAITING
}
```

而练习房的 `_fillAiSeats()` 给 AI 座位写的是 **`ready: false`**。
于是**任何一次** `_refreshReadyStatus()`（玩家点一下「准备」按钮就够）
都会让练习房 `READY → WAITING`，随后自动开局必然抛错。

关键点：`createRoom` 里是先 `_fillAiSeats()` 再无条件 `_setStatus(READY)`，
所以**首次**开局是好的 —— 这解释了为什么它时好时坏、看起来像竞态。

**修复**（三处，防御层层递进）：

| 位置 | 改动 |
| :--- | :--- |
| `_fillAiSeats` 之后 | 把 AI 座位显式标为 `ready = true`（语义正确：AI 本来就随时能开局） |
| `_refreshReadyStatus` | 练习房直接短路：只要不是 PLAYING 就保持在 READY，**不参与准备判定** |
| `startRoom` | 门槛改为 `status !== READY && !isPractice`，练习房不因瞬时状态被拦 |
| `RoomScene._onRoomState` | 自动开局条件显式排除 PLAYING/FINISHED/DISSOLVED，避免状态推送重复开局 |
| `startRoom` 报错信息 | 把 `status / isPractice / 各座位准备情况` 打进错误文本，下次一眼定位 |

### 7.2 寻机头点击棋盘「没有任何反应」（五子棋正常）

**症状**：AI 练习进对局后，棋盘显示正常，但**点任何格子都没反应**。
五子棋同样的流程却正常 —— 差异在两款游戏的 Authority 构造函数签名。

**根因：实参错位。** `PlaneHuntAuthority` 的签名是
`(roomId, firstPlayerId, secondPlayerId, aiPlayerId, seed, level)`，
而 `GameScene` 传的是：

```typescript
new PlaneHuntAuthority(
    ctx.room.roomId,
    ctx.firstPlayerId,
    ctx.myPlayerId,        // ← 这一位是 secondPlayerId，却被传了「我」
    ctx.opponent.playerId,
    ...
```

`secondPlayerId` 与 `firstPlayerId` 都成了我自己 → `PlaneHuntRules.opponentOf()`
遍历 `_scores` 找不到「非我」的 id → **返回空字符串** →
下发结果 `nextPlayerId = ''` → 客户端 `isMyTurn()` 恒为 `false` →
`onPlayerClick` 第一道判断就 `return`。**静默失败，连警告都没有。**

第二个独立缺陷：客户端 `PlaneHuntGame._applyFlipResult()` 里原本有一行
`this._rules = this._rules;`（自我赋值，注释还写着「保留引用语义」）——
本地 `_rules` 是**另一个实例**，回合状态永远不会推进，
所以即使 `nextPlayerId` 正常，`isMyTurn()` 也读的是过期数据。

**修复**：

| 位置 | 改动 |
| :--- | :--- |
| `GameScene` | 按签名正确传参：`secondId = (firstId === myPlayerId) ? oppId : myPlayerId`，并加注释说明与五子棋 Authority 签名不同、易踩 |
| `PlaneHuntGame` | 新增 `_serverTurnId`，回合判定改为「以权威下发为准」；`_applyFlipResult` 里记录 `p.nextPlayerId` |
| `PlaneHuntGame` | 删掉 `this._rules = this._rules` 自我赋值；补注释说明「客户端不自行推演棋局」 |
| `PlaneHuntRules` | **构造时防呆**：两名玩家 id 相同/为空即 `console.error`，把静默失败变成显式报警 |

### 7.3 顺带修掉的一个真 bug：寻机头得分归属错位

`PlaneHuntBoard.revealCell()` 用 `this._isMyTurn` 判断这一格该给谁记分。
但该方法是在 `setTurn()` **之后**被调用的 —— 那时 `_isMyTurn` 已经是
**翻完之后**的回合方。于是「对手翻中的机头」会被记到我方得分上，双方得分整体错位。
（还有一行 `this._myPlayerId === this._firstPlayerId ? score : score` —— 三元两边同值，
等于没判断。）

**修复**：协议里补 `byPlayerId`（翻格者），板子按「谁翻的」归属：
`PlaneHuntRules.FlipResult.byPlayerId` → `PhFlipResultPayload.byPlayerId` →
`revealCell(..., byMe, ...)`。归属与回合是两件事 —— 翻中机头会奖励连翻，
此时**归属变了但回合没变**，用回合反推归属必然出错。

### 7.4 模式选择弹窗：选项偏大、会压到取消按钮

**修复**：

- 选项按钮 88 → **72** 高、宽度 440，间距 14（原 110 的行距里按钮占 88，留白不均）
- 选项区包进 **ScrollView**（`view` 挂 `Mask` + `content` 锚点 `(0.5,1)` 顶部对齐，
  纵向、惯性、弹性滚动），固定可视高 **300**；内容不足时不滚动
- 面板高度改为**分区计算**：标题区 120 + 选项区 + 取消区 104。
  取消按钮独立在面板底部，**结构上不可能**被选项压住（原来是绝对定位硬凑，
  选项一多就重叠）
- 日志补 `选项数 / 面板高 / 选项区高 / 内容高 / (需/无需滚动)`，方便核对

> 从「绝对定位硬凑坐标」改成「分区 + 可滚动容器」，是为了让**选项数量变成配置驱动的**：
> 将来加「人机难度」「好友房」等入口时不会再次压版。

### 7.5 棋盘 UI：白子看不见、网格线太浅

**根因（纯设计令牌问题，改一处即可全局生效）**：`UITheme.BOARD` 里

| 令牌 | 原值 | 问题 |
| :--- | :--- | :--- |
| `gomokuBg` / `whiteStone` | **都是 `#FFFFFF`** | 白子与棋盘底同色，落上去只剩 1px 描边，看起来「没有子」 |
| `gomokuLine` | `#D8DDE4` | 在白底上对比度极低，15×15 几乎看不出格子 |
| `stoneEdge` | `#C9D0DA` | 白子描边太浅，等于没有 |
| `huntLine` | `#DFE3E9` | 同上（寻机头） |

**修复**（只改 `UITheme.ts` 的 `BOARD`，两个棋盘共用一套视觉语言）：

| 令牌 | 新值 | 理由 |
| :--- | :--- | :--- |
| `gomokuBg` / `huntBg` | `#F4EFE7` | 暖灰白（有底色感，与纯白棋子拉开差） |
| `gomokuLine` / `huntLine` | `#A9B2BF` | 中灰 —— 线终于「看得见」 |
| `stoneEdge` | `#8E99A8` | 白子描边加深，成为与盘底的主要区分手段 |
| `huntHidden` | `#FBF7F1` | 未翻格比底略浅，与底区分但不抢眼 |
| `huntEmpty` | `#FFFFFF` | 已翻空格比未翻更亮（翻开的语义） |

配套代码：白子描边 6%→**8% 且至少 2px**；黑子也加同色描边让边缘更实；
两盘网格线线宽 3%/5% → **统一 6%**。`UITheme.ts` 的 `BOARD` 上方补了
「白子不能与盘底同色 / 网格线不能再浅」的硬约束注释。

### 本轮验证

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| 场景生成 | `node tools/gen-scenes.js` | ✅ 4 场景 |
| 场景结构 + 层级护栏 | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 严格类型校验 | `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| 纯逻辑单测（含本轮回归） | `node tools/test-core.js` | ✅ **49 通过, 0 失败**（原 40） |

新增回归断言（锁住 7.2 的契约，防止再次实参错位）：

- 翻格后 `nextPlayerId` 非空、且从 p1 交接到 p2
- 翻转结果带 `byPlayerId` 归属
- **两名玩家相同时 `opponentOf` 返回空** —— 即「构造错误可被检出」
- 翻中机头 → `extraTurn=true` 且回合**不**切换，但归属仍是翻格者

### 方法：先复现，再修

7.1 和 7.2 都能靠读代码猜出「大概的原因」，但本轮刻意先写了复现脚本，
用 `tools/test-core.js` 同款的 TS 转译手法加载**真实类**并驱动真实调用序列。
收益很直接：7.2 的第一版猜测（「客户端没同步回合」）只是**次要**缺陷，
真正让棋盘死掉的是 `nextPlayerId = ''`；如果不跑一遍，
修完次要缺陷后症状不变，又得多一轮往返。

复现输出（修复前）：

```
翻格结果: cell=0 scored=false nextPlayerId=""      ← 空！回合断了
权威.当前回合(翻后) =                               ← 空
```

教训与第 4/6 轮同源：**「日志正常但功能不工作」时，把中间值打出来看，
不要继续在推理链上往下猜。**

---

## 第 8 轮：棋盘外框/线条统一 + HUD 重排 + 寻机头规则改为「换手」

**日期**：2026-09-16

四个需求，其中一个是**游戏规则变更**（影响规则层/协议/测试/文案），
其余三个是视觉与信息层次调整。

### 8.1 棋盘四周加粗外框 + 线条颜色粗细统一

**问题**：棋盘只是一堆细线，看不出「一块板」的边界，会「浮」在页面上。
且两盘的线条**颜色和粗细都不同**（五子棋 5%、寻机头 3%，各自写死）。

**修复**：把「外框 / 线条」抽到 `BoardBase` 共用，两盘**只能**从这里取：

| 方法 | 作用 |
| :--- | :--- |
| `gridLineWidth()` | 网格线宽 = 格子尺寸 6%，夹在 [1,3]（**两盘同一个公式**） |
| `borderLineWidth()` | 外框 = 网格线 × 3，至少 4px |
| `boardPad()` | 底板外扩边距（外框与网格之间留白） |
| `drawBoardFrame(g, bg, line)` | 底板 + **加粗外框**（线心内缩半个线宽，避免被裁） |
| `drawGridLines(g, line, n, step)` | 统一线宽的竖线 + 横线 |

颜色令牌也合并：原来 `gomokuLine` / `huntLine` 两个值，现在统一为
**`BOARD.boardLine = '#B9C0CA'`**（两盘线条 + 外框同色）。

> 抽成共用方法而不是「两边改成一样的数字」，是因为**数字可以再次被改散**。
> 现在改一处两盘同步，这是结构上的保证，不是纪律上的。

### 8.2 Game 页双方布局重排 + 回合归属显示

**问题（真 bug）**：`_myTurnLabel` 和 `_oppTurnLabel` **指向同一个节点**
（都是 `Canvas/Hud/TurnLabel`），`_refreshHud` 与 `_hudTick` 里两条分支
每帧互相覆盖 —— 这就是「看不出当前是谁的回合」的直接原因。
而原布局把双方信息塞成两行、分数靠右，双方关系也不清楚。

**修复**：

| 项 | 改动 |
| :--- | :--- |
| HUD 高度 | 220 → 248（腾出独立的「回合行」与「机头进度行」） |
| 双栏布局 | 左右两栏 = **对手 \| 我**（各 328 宽），中缝一条 1px 竖分隔线 |
| 分数 | 升级为 `FONT.display` 大字，两栏各自居中（原来挤在右侧一列） |
| 回合指示 | **一个** `Hud/TurnLabel` + 两个高亮圆点 `Hud/MyTurnMark` / `Hud/OppTurnMark`（◆ 只出现在当前回合方） |
| 回合高亮 | 当前回合方的**昵称**提色（主色），另一侧压暗；文案颜色 我=绿 / 对手=橙 |
| 渲染入口 | 抽出 `_renderTurn(myTurn)`，返回「文案是否变化」→ 只有真变化才重置倒计时（否则每帧都重置） |

### 8.3 寻机头额外显示「已找到机头数 n / 5」

新增 `Hud/HeadsLabel`，由 `GameScene` 每帧从棋盘读
`getHeadsFound()` / `getHeadTotal()` 写入；全部找齐时变色为成功色。
`PlaneHuntBoard` 新增这两个 getter（数据来自权威下发的 `setTurn(...)`）。
非寻机头对局将其置为空格隐藏。

### 8.4 规则变更：翻到机头**不再**奖励连翻，直接换手

**原因**（用户实测反馈）：一方连翻、对手干等，回合归属在 UI 上很难看懂，
且与「交替行动」的直觉不符。

**改动**：`PlaneHuntRules.applyFlip()` 里删掉 `extraTurn` 分支，
只要对局未结束就 `_currentPlayerId = opponentOf(playerId)`。
`extraTurn` 字段**保留**在协议里恒为 `false`（不破坏消息结构）。

连带修正的几处（容易漏，记下来）：

| 位置 | 改动 |
| :--- | :--- |
| `PlaneHuntBoard.showBonusTip` | 改名 `showScoreTip`，文案「机头！再翻一次」→「**机头！+1 分**」（原文案在新规则下是错的） |
| `PlaneHuntGame._applyFlipResult` | 触发条件从 `p.extraTurn` 改为 `p.scored`（前者恒 false，提示会永不出现） |
| `tools/test-core.js` | 6 条断言原本锁死旧规则（含「翻 3 个机头靠连翻」的测试前提），改为按当前回合交替翻格；新增「先手拿 3 个 / 后手拿 2 个 / 先手胜」的明确断言 |

> ⚠️ 规则变更必然让「编码了旧规则的测试」失败 —— 这**不是**测试坏了，
> 是它在正确地报警。本轮 6 条 FAIL 全部属于此类，逐条改成新契约。
> AI 侧无需改动：它只查 `rules.currentPlayerId`，天然跟随回合。

### 8.5 顺带加的两道护栏（都是「我手工核过、所以要变成自动的」）

1. **Game 场景 HUD 路径契约 + 纵向不重叠断言**（`validate-scenes.js` 新增 B2 节）：
   - GameScene 按**路径字符串**绑定 HUD 节点，改名/挪位不会报错、只会静默失效；
   - 各区块是绝对定位的，改一处高度就可能压到别处（本轮 HUD 加高时差点压到棋盘）。
   - 断言 9 个 HUD 节点路径齐全 + `Hud / BoardArea / EmotePanel / ActionBar`
     自上而下依次不重叠。**已用「故意把棋盘上移到 y=200」验证可证伪**：
     正确报出 `FAIL Hud 与 BoardArea 纵向不重叠（间隙 -140px）`。
2. 空 Label 拦截：`HeadsLabel` 初值不能给空串，否则 `validate-scenes.js`
   报「所有 Label 有非空 _string」失败 —— 这条既有规则本轮真的拦住了我一次，
   说明它在干活。

### 本轮验证

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| 场景生成 | `node tools/gen-scenes.js` | ✅ 4 场景（Game 增至 29 节点 / 14 Label） |
| 场景结构 + HUD 契约 + 不重叠 + 层级护栏 | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 严格类型校验 | `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| 纯逻辑单测 | `node tools/test-core.js` | ✅ **52 通过, 0 失败** |
| 新断言可证伪 | 故意让棋盘与 HUD 重叠 | ✅ 正确报 FAIL（间隙 -140px） |

**仍需真人确认**（我无法渲染）：外框粗细是否合适、双栏 HUD 的信息层次是否好读、
「◆ 高亮 + 昵称提色」能否一眼看出回合归属、两盘线条观感是否统一。

---

## 配置概览

| 参数 | 值 |
| :--- | :--- |
| 设计分辨率 | 720 × 1280（fitWidth=true, fitHeight=false） |
| 帧率 | 60 FPS |
| 启动场景 | `db://assets/scenes/Loading.scene` |
| 渲染管线 | 内置管线 `builtin-pipeline` |
| 引擎模块 | 已裁掉 3D / 骨骼动画 / 自定义管线 / WebGPU |
