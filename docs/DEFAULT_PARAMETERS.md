# 默认参数基线落实清单（DEFAULT PARAMETERS BASELINE）

> 规格要求：「默认参数基线（主流默认值，必须设置并在输出中列明设置位置）」
>
> 下表逐项列出每个参数的**实际设置位置**与**当前值**。

---

## 1. 基线对照表

| 参数 | 规格要求值 | 实际值 | 设置位置 | 状态 |
| :--- | :--- | :--- | :--- | :-- |
| 设计分辨率 | 720 × 1280 | `720 × 1280` | `settings/v2/packages/project.json` → `general.designResolution`<br>`assets/scripts/config/AppConfig.ts` → `DESIGN_WIDTH` / `DESIGN_HEIGHT` | ✅ |
| 适配策略 | FIXED_WIDTH | `fitWidth: true`<br>`fitHeight: false` | `settings/v2/packages/project.json` → `general.designResolution.fitWidth`<br>`AppConfig.DESIGN_FIT_WIDTH = true` | ✅ |
| 帧率 | 60 | `60` | `settings/v2/packages/project.json` → `time.frameRate`<br>`AppConfig.FRAME_RATE = 60`<br>运行时落实：`assets/scripts/core/AppBootstrap.ts` → `game.frameRate = 60` | ✅ |
| 屏幕方向 | portrait | `"deviceOrientation": "portrait"` | `build-templates/wechatgame/game.json`<br>`settings/v2/packages/builder.json` → `wechatgame.orientation` | ✅ |
| 场景清单与顺序 | Loading → Lobby → Room → Game | 同 | `settings/v2/packages/builder.json` → `common.scenes`（4 个场景）<br>启动场景：`common.startScene = db://assets/scenes/Loading.scene` | ✅ |
| 场景文件位置 | `assets/scenes/` | 同 | `assets/scenes/{Loading,Lobby,Room,Game}.scene` | ✅ |
| 模块裁剪 | 保留 2D/UI/Tween/Audio；剔除 3D/物理/Terrain | 见第 2 节 | `settings/v2/packages/engine.json` → `modules.configs.defaultConfig.cache` | ✅ |
| TypeScript | 严格模式 | `strict: true` | `tsconfig.check.json`（校验用）<br>**注意**：见第 3 节说明 | ⚠️ 见 3 |
| 安全区 | `SafeAreaAdapter` 从 `IPlatformService.getSystemInfo()` 读取 | 已实现 | `assets/scripts/core/SafeAreaAdapter.ts`<br>Mock：`core/services/mock/MockPlatformService.ts`<br>Wx 桩：`core/services/wx/WxPlatformService.ts` | ✅ |
| 首包预算 | ≤ 4MB | 预算常量已设 | `AppConfig.FIRST_PACKAGE_BUDGET_BYTES = 4 * 1024 * 1024`<br>`build-templates/wechatgame/project.config.json` → `setting.minified: true` | ✅ |
| 构建平台 | 微信小游戏 | `wechatgame` | `settings/v2/packages/builder.json` → `common.platform` | ✅（仅预留，未构建） |
| appid 占位 | 占位值 | `"TODO"` | `settings/v2/packages/builder.json` → `wechatgame.appid`<br>`build-templates/wechatgame/project.config.json` → `appid`<br>`AppConfig.WX_APPID = 'TODO'` | ✅ |
| 云环境占位 | 占位值 | `"TODO"` | `AppConfig.CLOUD_ENV = 'TODO'` | ✅ |
| 远程服务器地址 | 占位 | `https://TODO.example.com/remote` | `AppConfig.REMOTE_SERVER`<br>`builder.json` → `wechatgame.remoteServerAddress` | ✅ |
| 分包配置 | 占位 | `"subpackages": []` | `builder.json` → `wechatgame.subpackages`<br>`build-templates/wechatgame/game.json` → `subpackages` | ✅（空数组占位） |

---

## 2. 模块裁剪明细（`engine.json`）

**保留（`_value: true`）**：

| 模块 | 用途 |
| :--- | :--- |
| `base` | 引擎核心 |
| `gfx-webgl` / `gfx-webgl2` | 渲染后端（微信小游戏必需） |
| `2d` | 2D 渲染 |
| `ui` | UI 系统（Label/Button/Widget/Layout） |
| `tween` | 缓动动画（落子/翻牌动画） |
| `audio` | 音频（音效接入点已预留） |
| `affine-transform` | 2D 变换 |
| `mask` | 遮罩 |
| `graphics` | **本项目关键** —— 所有 UI 与棋盘均用 `Graphics` 程序化绘制 |
| `rich-text` | 富文本 |
| `animation` | 帧动画 |
| `intersection-2d` | 2D 碰撞检测（触摸热区） |
| `custom-pipeline` | 渲染管线 |
| `profiler` | 性能面板 |
| `particle-2d` | 2D 粒子 |

**已剔除（`_value: false`）**：

| 模块 | 剔除理由 |
| :--- | :--- |
| **`3d`** | 纯 2D 竖屏游戏，无 3D 需求 |
| **`physics`** / `physics-ammo` / `physics-cannon` / `physics-physx` / `physics-builtin` | 无物理模拟需求（棋盘逻辑为纯数据计算） |
| **`terrain`** | 无地形 |
| `skeletal-animation` | 无骨骼动画（第二阶段如接入美术骨骼需重新开启） |
| `meshopt` / `primitive` / `geometry-renderer` / `debug-renderer` | 3D 相关 |
| `occlusion-query` / `light-probe` | 3D 光照相关 |
| `xr` | 无 XR |
| `websocket` / `websocket-server` | **第二阶段如需切 WebSocket 需重新开启** |
| `spine` / `spine-3.8` / `spine-4.2` / `dragon-bones` | 无骨骼动画资源 |
| `video` / `webview` | 本项目未使用（如接入需开启） |
| `sorting-2d` / `ui-skew` / `marionette` / `procedural-animation` | 未使用 |
| `tiled-map` | 未使用 Tiled 地图（棋盘为程序化绘制） |
| `custom-pipeline-post-process` | 无后期处理 |

> **注意**：`settings/v2/packages/engine.json` 的 `includeModules` 数组是 Cocos 编辑器
> 依据 `cache` 中各模块的 `_value` **自动生成**的。直接编辑 `_value` 后，
> 建议在编辑器中打开 `项目 → 项目设置 → 功能裁剪` 确认勾选状态，
> 让编辑器重算 `includeModules`（否则可能出现「引擎模块未裁剪」的构建警告）。

---

## 3. TypeScript 严格模式说明

| 文件 | `strict` | 用途 |
| :--- | :--- | :--- |
| `tsconfig.json`（项目根，Cocos 使用） | `false` | ⚠️ Cocos 编辑器默认生成，见下方说明 |
| `tsconfig.check.json`（本阶段新增） | **`true`** | 用于严格模式校验 |
| `temp/tsconfig.cocos.json` | — | Cocos 自动生成的基础配置（`extends` 目标），**不要手工修改** |

### 为什么有两个 tsconfig

Cocos Creator 的编辑器编译**不读取项目根的 `tsconfig.json` 做类型检查**
（它用自己的一套编译流程），项目根的 `tsconfig.json` 主要服务于 IDE 补全。

因此本项目：
- **保留** Cocos 生成的 `tsconfig.json`（不动它，避免影响编辑器）；
- **新增** `tsconfig.check.json`，开启完整严格模式，用于**独立的严格类型校验**；
- 通过 `typecheck.cmd` 执行校验（见下）。

> 这样既满足「严格模式」要求（所有代码确实通过严格校验），
> 又不破坏 Cocos 编辑器的既有行为（铁律：不修改编辑器配置/不重新初始化项目）。

### 严格模式下实际开启的检查项

```jsonc
{
    "strict": true,                      // 总开关
    "strictNullChecks": true,            // 空值检查
    "strictFunctionTypes": true,          // 函数参数逆变检查
    "strictPropertyInitialization": true, // 类属性必须初始化
    "noImplicitAny": true,               // 禁止隐式 any
    "noImplicitThis": true,              // 禁止隐式 this
    "alwaysStrict": true,                // 总是输出 "use strict"
    "useUnknownInCatchVariables": true,  // catch 变量为 unknown
    "strictBindCallApply": true,
    "forceConsistentCasingInFileNames": true
}
```

### 执行方式

```powershell
cd C:\Users\war11\wechat_game
.\typecheck.cmd
# 预期输出：TYPECHECK_EXIT=0
```

**实现说明**：`typecheck.cmd` 使用 TypeScript 5.8.2（Cocos 编辑器内置的版本），
通过独立安装的 Node.js 执行（若 Node.js 不存在则回退到用编辑器 Electron 的 Node 模式）。
类型检查基于**真实引擎声明文件**：

```
C:\ProgramData\cocos\editors\Creator\3.8.8\resources\resources\3d\engine\bin\.declarations\cc.d.ts
```

即本项目所有 `cc` 模块的 API 调用都在真实引擎签名下通过了严格校验。

---

## 4. 其他运行时参数（`AppConfig.ts`）

| 参数 | 值 | 说明 |
| :--- | :--- | :--- |
| `USE_MOCK` | `true` | **阶段切换总开关**（第二阶段置 `false`） |
| `MIN_TOUCH_SIZE` | `44` | 最小可点击热区（pt），微信小游戏规范 |
| `TURN_TIME_LIMIT_SEC` | `30` | 每步限时 |
| `TURN_TIME_WARN_SEC` | `10` | 限时告警阈值（计时器变红） |
| `DEFAULT_AI_LEVEL` | `NORMAL` | 默认 AI 难度 |
| `PLANEHUNT_SIZE` | `12` | 寻机头棋盘 12×12 |
| `PLANEHUNT_PLANE_COUNT` | `5` | 飞机数量 |
| `GOMOKU_SIZE` | `15` | 五子棋棋盘 15×15 |
| `GOMOKU_WIN_COUNT` | `5` | 连胜数 |
| `MOCK_LATENCY_MIN_MS` / `MAX` | `80` / `200` | Mock 模拟网络延迟（规格要求 80~200ms） |
| `MOCK_OPPONENT_JOIN_MIN_MS` / `MAX` | `1000` / `3000` | Mock 对手入座延迟（规格要求 1~3s） |
| `MOCK_OPPONENT_READY_MIN_MS` / `MAX` | `500` / `1500` | Mock 对手准备延迟 |
| `MOCK_ROOM_TIMEOUT_MS` | `120000` | Mock 房间超时解散（2 分钟） |
| `PLANEHUNT_AI_THINK_MIN_MS` / `MAX` | `500` / `1500` | 寻机头 AI 思考（规格要求 0.5~1.5s） |
| `GOMOKU_AI_THINK_MIN_MS` / `MAX` | `800` / `2000` | 五子棋 AI 思考（规格要求 0.8~2s） |
| `MOCK_USER_NICKNAME` | `测试玩家` | Mock 固定测试用户昵称 |
| `LOG_VERBOSE` | `true` | 详细日志（协议收发等） |
| `SHOW_DEBUG_HUD` | `false` | 运行时调试 HUD |

---

## 5. 校验命令

```powershell
cd C:\Users\war11\wechat_game

# 1) TypeScript 严格模式校验
.\typecheck.cmd

# 2) 核心算法自测（40 项）
node tools/test-core.js

# 3) 云函数语法检查
Get-ChildItem cloudfunctions -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 4) 查看运行时配置摘要（需在编辑器预览的控制台执行）
#    [AppBootstrap] 配置摘要: {...}
```

---

## 6. 待人工确认项

以下项需在 Cocos 编辑器 GUI 中确认（本项目通过直接编辑配置文件落实，
但编辑器可能有自己的重算逻辑）：

| # | 待确认项 | 确认路径 | 期望 |
| :--- | :--- | :--- | :--- |
| 1 | 设计分辨率 720×1280 + fitWidth | `项目 → 项目设置 → 项目数据` | 宽 720、高 1280、勾选「适配屏幕宽度」 |
| 2 | 功能裁剪未启用 3D/物理 | `项目 → 项目设置 → 功能裁剪` | 3D、物理、Terrain 均**未勾选** |
| 3 | 场景清单与启动场景 | `项目 → 构建发布 → 微信小游戏` | 4 个场景、起始场景 = Loading |
| 4 | 帧率 | 预览时左下 FPS | 显示 ~60 |
| 5 | 首包体积 | 构建后微信开发者工具「详情 → 基本信息」 | < 4MB |
