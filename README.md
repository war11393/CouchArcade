# CouchArcade

> **沙发不在，朋友还在。**
>
> 一个为「几个朋友凑一局」而生的微信小游戏合集。

周末想和朋友来一局五子棋，结果三个人在三个地方。
开黑软件要装、要注册、要开麦 —— 就为了下一把棋。

CouchArcade 的答案很直接：**你们本来就在一个微信群里**。
群就是客厅，微信就是那张沙发。

| 版本 | 阶段 | 状态 |
| :--- | :--- | :--- |
| [v0.1.1](VERSION.md) | 阶段一 · Cocos 编辑器内调试 | 🎯 **里程碑达成**（Cocos 侧功能基本可用） |
| [v0.1.0](VERSION.md) | 阶段一 · Cocos 编辑器内调试 | ✅ 初始版本 |
| v0.2.0（计划） | 阶段二 · 微信开发者工具（SDK / 广告挂接） | ⏳ 未开始 |
| v1.0.0（计划） | 阶段三 · 上线 | ⏳ 未开始 |

版本规划与阶段目标见 **[VERSION.md](VERSION.md)**。

## 两款游戏

| 游戏 | 玩法 |
| :--- | :--- |
| **寻机头** | 12×12 棋盘，5 架飞机藏于格下。翻到机头得分并**额外获得一次机会**，翻到机身只揭示不奖励。5 个机头全部现身后，机头多者胜。 |
| **五子棋** | 经典 15×15，黑先白后，无禁手。AI 采用「己方成五 > 封堵对方 > 综合评分」的优先级策略。 |

## 它是怎么做到"不需要真的联机软件"的

这不是一个"加了联网功能"的单机游戏，而是一套**从第一天就按联机设计**的双模式架构：

- 玩家操作 → 同步协议通道 → **权威裁判**校验判定 → 标准下行消息回传
- 对面是真人还是 AI，**业务层完全分不清** —— 走的是同一套协议
- 编辑器里 `USE_MOCK=true` 全流程可玩；置为 `false` 即接微信云函数，业务代码**零改动**

所以「和朋友玩」和「自己练手」是同一份代码、同一条链路。

## 技术选型

Cocos Creator 3.8.8 · TypeScript 严格模式 · 微信小游戏（竖屏 720×1280）
平台抽象层（7 个接口）+ Mock/Wx 双实现 · 服务端权威 · 配置驱动扩展
**零美术资源** —— 界面全部由 `UIFactory` 在运行时以代码构建

新增一款游戏只需 3 步：登记 `GameList` → 实现 `IGame` → 注册 `GameRegistry`。
大厅、房间、对局场景无需任何改动。

---

## 1. 快速开始

### 编辑器预览（第一阶段验收）

1. 用 Cocos Creator 3.8.8 打开项目根目录
2. 打开 `assets/scenes/Loading.scene`
3. 点 ▶ 预览（`Ctrl+P`）→ 浏览器自动打开 `http://localhost:7456`
4. 按 `F12` 看控制台，应看到 `[ServiceLocator] 注入 Mock 实现（编辑器预览模式）`

**验收清单**：`docs/SELF_TEST_CHECKLIST.md`（M1~M5 逐条勾选）

### 自动化验证（无需编辑器）

```powershell
cd C:\Users\war11\wechat_game

# TypeScript 严格模式类型检查
.\typecheck.cmd                      # 期望 TYPECHECK_EXIT=0

# 核心算法自测（52 项：规则 + AI + 布局生成）
node tools/test-core.js              # 期望 52 通过 / 0 失败

# 云函数语法检查
Get-ChildItem cloudfunctions -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
```

> 重新生成场景文件：`node tools/gen-scenes.js`
> 重新生成云函数 package.json 与 common.js：`node tools/gen-cloudfunctions.js`

---

## 2. 阶段边界

| | 阶段一（当前） | 阶段二（人工） | 阶段三（人工） |
| :--- | :--- | :--- | :--- |
| 目标 | Cocos 编辑器内调试 | 微信开发者工具：SDK / 广告挂接 | 上线 |
| 平台实现 | `MockXxx`（编辑器可玩） | 实现 `WxXxx` 桩 | 真机全链路 |
| 切换开关 | `AppConfig.USE_MOCK = true` | 置为 `false` | 同上 |
| 构建部署 | ❌ 不做（仅参数预留） | 构建 → 部署云函数 → 真机调 | 提审 → 发布 |

> 完整的阶段划分、版本号规则与目标见 **[VERSION.md](VERSION.md)**。

**已遵守的铁律**：
- ✅ 业务层**零 `wx.*` 直接调用**（全部经 `core/services/` 抽象层）
- ✅ `USE_MOCK=true` 时编辑器预览全流程可玩、零报错
- ✅ 每个微信能力位都有 Wx 桩 + `TODO(wechat-phase2)` + 收录进联通清单
- ✅ 未修改编辑器版本、未重新初始化项目、未执行微信构建/部署

---

## 3. 目录结构

```
wechat_game/
├── assets/
│   ├── scenes/                        # 4 个场景（Loading → Lobby → Room → Game）
│   │   ├── Loading.scene
│   │   ├── Lobby.scene
│   │   ├── Room.scene
│   │   └── Game.scene
│   └── scripts/
│       ├── config/
│       │   ├── AppConfig.ts           # ★ 全局配置 + USE_MOCK 总开关
│       │   ├── GameList.ts            # 游戏列表配置（配置驱动大厅）
│       │   └── Collections.ts         # 集合名/云函数名/存储 key 常量
│       ├── core/
│       │   ├── ServiceLocator.ts      # ★ 依据 USE_MOCK 注入 Mock/Wx 实现
│       │   ├── EventBus.ts            # 全局事件总线
│       │   ├── SafeAreaAdapter.ts     # ★ 安全区适配组件
│       │   ├── UIFactory.ts           # 程序化 UI 构建（零美术资源）
│       │   ├── UIManager.ts           # 场景路由 + Toast + 结算弹窗
│       │   ├── AppBootstrap.ts        # 启动引导（帧率/服务注入）
│       │   ├── protocol/
│       │   │   └── Protocol.ts        # ★ 消息协议（信封 + 命令字 + payload）
│       │   └── services/
│       │       ├── IServices.ts       # ★ 7 个平台能力接口定义
│       │       ├── mock/              # Mock 实现（编辑器可用）
│       │       │   ├── MockPlatformService.ts
│       │       │   ├── MockAuthService.ts
│       │       │   ├── MockRoomService.ts
│       │       │   ├── MockNetSyncService.ts   # ★ 协议通道 + 权威裁判模型
│       │       │   ├── MockShareService.ts
│       │       │   ├── MockStorageService.ts
│       │       │   └── MockCloudService.ts
│       │       └── wx/                # Wx 桩（签名完整 + TODO）
│       │           ├── WxPlatformService.ts
│       │           ├── WxAuthService.ts
│       │           ├── WxRoomService.ts
│       │           ├── WxNetSyncService.ts
│       │           ├── WxShareService.ts
│       │           ├── WxStorageService.ts
│       │           └── WxCloudService.ts
│       ├── games/
│       │   ├── common/
│       │   │   ├── IGame.ts           # ★ 游戏统一接口 + ILayoutProvider
│       │   │   ├── BoardBase.ts       # 棋盘基类（自适应 + 坐标换算）
│       │   │   └── GameRegistry.ts    # 游戏注册表（配置驱动）
│       │   ├── planehunt/             # 寻机头
│       │   │   ├── PlaneHuntLayout.ts # 布局生成（旋转+碰撞+重试）+ Rng
│       │   │   ├── PlaneHuntRules.ts  # 翻格规则 + 机头奖励
│       │   │   ├── PlaneHuntAi.ts     # AI（随机 + 机身邻域探索）
│       │   │   ├── PlaneHuntBoard.ts  # 12×12 棋盘视图
│       │   │   └── PlaneHuntGame.ts   # ★ IGame 实现 + 权威裁判
│       │   └── gomoku/                # 五子棋
│       │       ├── GomokuRules.ts     # 规则 + 高效五连检测
│       │       ├── GomokuAi.ts        # AI 评分启发式
│       │       ├── GomokuBoard.ts     # 15×15 棋盘视图
│       │       └── GomokuGame.ts      # ★ IGame 实现 + 权威裁判
│       ├── lobby/
│       │   └── LoadingScene.ts        # 启动页（登录/云初始化/更新预留）
│       ├── room/
│       │   ├── RoomScene.ts           # 房间/座位状态机
│       │   └── GameScene.ts           # 对局界面（HUD + 动态挂载棋盘）
│       └── stats/
│           └── StatsService.ts        # 战绩写入（经 ICloudService）
├── cloudfunctions/                    # 9 个云函数（第二阶段部署）
│   ├── common/index.js                # 公共模块（复制到各函数目录）
│   ├── login/
│   ├── createRoom/
│   ├── joinRoom/
│   ├── ready/
│   ├── startGame/
│   ├── getRoomState/
│   ├── planehunt_flip/
│   ├── gomoku_move/
│   └── settleGame/
├── docs/
│   ├── WECHAT_INTEGRATION_CHECKLIST.md  # ★ 联通清单 + 第二阶段操作手册
│   ├── PROTOCOL.md                       # ★ 消息协议 + 时序图
│   ├── CLOUD_DESIGN.md                   # ★ 集合设计 + 云函数职责
│   ├── REALTIME_CHANNEL_DECISION.md      # ★ 实时通道选型结论与理由
│   ├── DEFAULT_PARAMETERS.md             # ★ 默认参数基线落实清单
│   └── SELF_TEST_CHECKLIST.md            # ★ 编辑器预览自测清单
├── build-templates/wechatgame/        # 微信构建模板（portrait / appid 占位）
│   ├── game.json
│   └── project.config.json
├── tools/                             # 开发辅助脚本（不参与游戏运行）
│   ├── gen-scenes.js                  # 生成 4 个场景文件
│   ├── gen-cloudfunctions.js          # 生成云函数 package.json + common.js
│   └── test-core.js                   # 核心算法自测（52 项）
├── typecheck.cmd                      # TypeScript 严格模式校验入口
├── tsconfig.check.json                # 严格模式校验配置
└── settings/v2/packages/              # Cocos 项目设置
    ├── project.json                   # 720×1280 / fitWidth / 60fps
    ├── engine.json                    # 模块裁剪（剔除 3D/物理/Terrain）
    └── builder.json                   # 微信小游戏构建参数（预留）
```

---

## 4. 核心架构

### 4.1 平台抽象层（本阶段核心交付）

```
             业务层（games / room / lobby）
                        │  只依赖接口
                        ▼
              ┌─────────────────────┐
              │   IServices.ts      │  IPlatformService / IAuthService /
              │   (7 个接口)         │  IRoomService / INetSyncService /
              └─────────────────────┘  IShareService / IStorageService /
                        │               ICloudService
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
        ServiceLocator      依据 AppConfig.USE_MOCK 选择
              │
      ┌───────┴────────┐
      ▼                ▼
  MockXxx          WxXxx
  (编辑器可用)      (桩 + TODO，第二阶段实现)
```

**切换方式**：改一行 —— `AppConfig.USE_MOCK = false`。业务层零改动。

### 4.2 双模式统一（关键设计）

```
                  ┌─────────────────────┐
                  │   GomokuGame        │
                  │   PlaneHuntGame     │
                  │  （同一套规则+UI）    │
                  └──────────┬──────────┘
                             │ 只认 INetSyncService
                             ▼
                  ┌─────────────────────┐
                  │ MockNetSyncService  │
                  └──────────┬──────────┘
                             │ 上行 → 权威裁判 → 下行
                             ▼
                  ┌─────────────────────┐
                  │  IMockAuthority     │
                  │ （本地规则层担任）    │
                  │  · 校验合法性        │
                  │  · 算结果           │
                  │  · 轮到 AI 时驱动 AI │
                  └─────────────────────┘
```

**「Mock 联机 = 通过同步协议通道与 AI 对打」**：

- 玩家操作 → `send(cmd, payload)` → 权威裁判判定 → 封装成标准下行消息回传（带 80~200ms 延迟）
- AI 回合 → 权威裁判内部调用游戏 AI → **封装成完全相同的下行消息**回传
- 因此业务层**无法区分「真人」与「AI」** → 第一阶段即验证了协议与同步逻辑

> 验证方法见 `docs/SELF_TEST_CHECKLIST.md` 第 4.7~4.9 项。

### 4.3 服务端权威 & 防篡改

| 层 | 职责 | 说明 |
| :--- | :--- | :--- |
| 客户端 | 只提交**意图**（「我要翻 (r,c)」） | 绝不本地改棋局数据 |
| 权威层 | 校验 + 判定 + 返回结果 | Mock：本地权威裁判<br>真机：云函数 |
| 客户端 UI | 只按**下行结果**更新 | 与真实服务器模型一致 |

**关键约束**：
- 五子棋：`gk.move` 上行只带坐标，胜负由权威判定
- 寻机头：`ph.flip` 上行只带坐标，**格子内容由权威返回**；客户端永远拿不到完整布局
- 布局权威方抽象为 `ILayoutProvider`，第二阶段切云函数生成 + 加密存储

### 4.4 新增一款游戏（低成本扩展）

只需 3 步：

1. `assets/scripts/config/GameList.ts` 追加一条 `GameMeta`
2. `assets/scripts/games/<yourgame>/` 实现 `IGame` 接口（复用 `BoardBase`）
3. `assets/scripts/games/common/GameRegistry.ts` 注册工厂

大厅、房间、对局场景**无需任何改动**（全部配置驱动）。

---

## 5. 两款游戏实现要点

### 5.1 寻机头

| 项 | 实现 |
| :--- | :--- |
| 棋盘 | 12×12 |
| 飞机数 | 5 架，形态矩阵（含 1 机头 + 9 机身 = 10 格/架） |
| 布局算法 | `PlaneHuntLayout.ts`：随机位置 + 随机朝向(0/90/180/270) + 碰撞检测 + 失败重试 |
| 随机性 | `mulberry32` 确定性 RNG（seed 驱动，双端可复现）—— 服务端 `makeRng` 同算法 |
| 翻格规则 | 机头→得分+**额外一次**（连续奖励）；机身→揭示+回合结束；空→回合结束 |
| 胜负 | 5 机头全翻出后，机头多者胜，相同平局 |
| AI 策略 | 无信息随机；发现机身后优先探索**四邻域**；思考 0.5~1.5s |
| 自适应 | 12 列撑满安全区宽度，格子近正方形 |

### 5.2 五子棋

| 项 | 实现 |
| :--- | :--- |
| 棋盘 | 15×15，交叉点落子，黑先白后 |
| 胜负 | 横/竖/双斜先连五者胜；下满平局；MVP 无禁手 |
| 五连检测 | **仅检测落子点四方向**，O(4×winCount)，不遍历全盘 |
| AI 评分 | 遍历候选空位，`己方落子分 + 阻挡对方分 × 1.2`（略偏防守） |
| 权重梯队 | 活五(1e6) > 冲四/活四(1e5) > 活三(1e4) > 眠三(1e3) > 活二(1e2) > 眠二(1e1) |
| AI 优先级 | ① 己方成五（必胜）→ ② 封堵对方成五（必防）→ ③ 综合评分 |
| 思考延迟 | 0.8~2s |
| 表现 | 木纹背景、网格、星位、最后一手标记、落子/胜利动画 |

> ⚠️ AI 优先级中的 ① ② 是**独立于综合评分**的：早期版本把「成五分」与
> 「防守分 × 1.2」放在同一公式里比较，导致 `1e6 × 1.2 = 1.2e6 > 1e6`，
> AI 会为了堵对方而放弃自己的一步胜利。此缺陷已由 `tools/test-core.js` 捕获并修复。

---

## 6. 文档索引

| 文档 | 内容 |
| :--- | :--- |
| `VERSION.md` | **版本与阶段规划**（当前 v0.1.0 + 三阶段目标 + 版本号规则） |
| `docs/WECHAT_INTEGRATION_CHECKLIST.md` | **联通清单**（15 项：接口→wx API→桩位置→步骤→验证）+ 第二阶段操作手册 + 常见问题 |
| `docs/PROTOCOL.md` | 消息协议、命令字、payload 结构、错误码、时序图、扩展规范 |
| `docs/CLOUD_DESIGN.md` | 5 个集合的字段设计与索引、9 个云函数职责、权限、数据生命周期 |
| `docs/REALTIME_CHANNEL_DECISION.md` | 实时通道选型结论（watch vs WebSocket）与理由、风险、演进路径 |
| `docs/DEFAULT_PARAMETERS.md` | **默认参数基线落实清单**（每项参数的设置位置与当前值）+ 模块裁剪明细 |
| `docs/SELF_TEST_CHECKLIST.md` | 编辑器预览自测清单（M1~M5，逐条勾选） |
| `docs/UI_DESIGN.md` | UI 设计说明 |
| `FIX_REPORT.md` | **调试实录**（5 轮：场景序列化 → 服务注入 → UI 静态化 → 浮层不可见 → 加载页）。含引擎源码级根因分析与被证伪的错误诊断，踩坑前值得先读 |

---

## 7. 当前验证状态

| 检查项 | 命令 | 结果 |
| :--- | :--- | :--- |
| TypeScript 严格模式 | `.\typecheck.cmd` | ✅ `TYPECHECK_EXIT=0`（基于真实引擎声明） |
| 核心算法自测 | `node tools/test-core.js` | ✅ **52 通过 / 0 失败** |
| 场景结构与内容校验 | `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 云函数语法 | `node --check` | ✅ 全部通过（9 函数 + 公共模块） |

**尚未验证**（需人工在编辑器中执行）：

- ⚠️ 编辑器预览的实际可玩性（UI 布局、触摸响应、动画表现）
  → 请按 `docs/SELF_TEST_CHECKLIST.md` 逐条验收

---

## 8. 已知事项与后续建议

| # | 事项 | 说明 | 建议 |
| :--- | :--- | :--- | :--- |
| 1 | 寻机头布局的读权限风险 | `games_planehunt` 若「所有用户可读」，客户端技术上可读到 `cells` | 第二阶段按 `REALTIME_CHANNEL_DECISION.md` 的**方案 A**（敏感字段拆表）处理 |
| 2 | 头像为文字占位 | `UIFactory.createAvatar` 用「昵称首字 + 底色圆」 | 美术资源到位后替换为 Sprite |
| 3 | 加入房间为简化交互 | 当前用「随机房间号直进」验证链路，未接数字键盘 | 第二阶段接入 `EditBox` 或用自绘数字键盘 |
| 4 | 音效未接入 | 落子/翻格仅动画，无声音 | 预留 `AudioSource` 接入点已注释标注 |
| 5 | TS 严格模式的双 tsconfig | 项目根 `tsconfig.json` 保持 Cocos 默认（`strict:false`），另用 `tsconfig.check.json` 做严格校验 | 见 `DEFAULT_PARAMETERS.md` 第 3 节的说明 |
| 6 | 场景为代码构建 UI | 场景文件极简（仅 Canvas + 脚本），UI 在运行时用 `UIFactory` 生成 | 好处：零美术依赖、首包小；如需美术编辑，可逐步改为预制体 |
| 7 | 模块裁剪需编辑器确认 | 已直接编辑 `engine.json` 关闭 3D/物理等 | 建议在 `项目设置 → 功能裁剪` 中确认勾选状态 |
