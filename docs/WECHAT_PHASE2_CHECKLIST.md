# 第二阶段人工操作清单（WECHAT PHASE 2 CHECKLIST）

> **⚠️ 当前版本状态：未验证（UNVERIFIED）**
>
> 代码改动已全部提交（git 标签 `wechat-phase2-unverified`），
> 自动校验（typecheck / 单测 / 场景校验 / 云函数语法 / 边界铁律）**均通过**，
> 但**尚未经过任何真机验证**：未在微信开发者工具中构建、未部署云函数、
> 未创建集合、未做过真机联调。
>
> 完成本清单后，请把状态更新为「已验证」，并在 CHANGELOG 或本文件顶部注明验证日期与环境。
>
> **用途**：代码侧已全部就绪（7 个 Wx 服务实现完毕、`TODO(wechat-phase2)` 清零、
> `USE_MOCK = false`、appid/环境 ID 已填）。本文档是**你需要在微信侧手工完成的全部事项**，
> 按顺序勾选即可。
>
> 代码侧的设计说明与接口细节见 `docs/WECHAT_INTEGRATION_CHECKLIST.md`。
>
> 生成时间：2026-09-18 ｜ 环境 ID：`cloud1-d7gp1em2efcf2b05b` ｜ AppID：`wxd5cc731e7273d122`

---

## 阶段 0：重新构建（必做，否则所有代码改动都不生效）

- [ ] 打开 Cocos Creator 3.8.8，加载本项目
- [ ] 菜单 `项目 → 构建发布`
- [ ] 平台选 **微信小游戏**
- [ ] 确认配置：起始场景 = `Loading`、设备方向 = `portrait`、游戏名称 = `沙发派对`
- [ ] 点「构建」→ 产物覆盖到 `build/wechatgame/`

> ⚠️ **必须重新构建**：源码里 `CLOUD_ENV` 从 `TODO` 改成了真实环境 ID、
> `USE_MOCK` 从 `true` 改成了 `false`、7 个桩文件全部重写 ——
> 这些都在 `assets/` 里，不构建就不会进 `build/`。
>
> ⚠️ `build/` 每次构建会被**清空重建**。任何你在 `build/wechatgame/` 里手工改的东西都会丢，
> 需要长期保留的配置请改 `build-templates/wechatgame/` 或 `settings/v2/packages/builder.json`。

---

## 阶段 1：微信开发者工具基础配置

- [ ] 打开微信开发者工具，**导入项目**，目录选 **仓库根 `C:\Users\war11\wechat_game`**
      （**不是** `build/wechatgame/`，原因见 §1.0）
- [ ] 项目类型选 **小游戏**，AppID 填 `wxd5cc731e7273d122`
- [ ] 确认编译无报错（若报 `game.json` 相关错误，见文末「常见问题」）

### 1.0 为什么导入仓库根而不是 build/wechatgame

云函数要用 DevTools 的「右键 → 上传并部署」，这要求 **DevTools 在项目目录内能看到
`cloudfunctions/`**。而本仓库的布局是：

```
C:\Users\war11\wechat_game\        ← 导入这个（仓库根）
├── project.config.json            ← 新增：把两边接起来
│     miniprogramRoot  = "build/wechatgame/"   → 游戏本体（构建产物）
│     cloudfunctionRoot = "cloudfunctions/"    → 云函数源码
├── cloudfunctions/                ← 9 个云函数 + common（共享源）
└── build/wechatgame/              ← Cocos 构建产物（game.json / game.js 在这）
```

若直接导入 `build/wechatgame/`，DevTools 看不到外层的 `cloudfunctions/`，
**界面上不会出现云开发图标，也无法右键部署任何云函数**。

> ❌ 为什么不采用「把 cloudfunctions 拷进 build/wechatgame」：
> `build/` 是构建产物（已 gitignore），Cocos **每次构建先清空再写入** ——
> 拷进去的云函数会随每次重建消失，需要反复手动重拷。
> 仓库根方案一次配置长期有效。

> 🔴 **本文件里的 `packOptions.ignore` 必须保持为空数组 —— 不要往里面加东西。**
>
> 踩过的坑：曾加 `"assets"` 想排除 Cocos 源资源目录，游戏直接起不来：
> ```
> Error: module 'assets/internal/index.js' is not defined
> ```
> 因为 WeChat 解析 `packOptions.ignore` 是**相对于 `miniprogramRoot`（代码根）**，
> 而非项目根 —— `"assets"` 命中的是 `build/wechatgame/assets/`，
> 那正是游戏两个资源包（`internal` / `main`）的所在处。
>
> 有了 `miniprogramRoot`，仓库根其它目录本来就不会进包，无需任何 ignore。

> ⚠️ **务必核对 AppID**：打开 `详情 → 基本信息`，确认 AppID 是 `wxd5cc731e7273d122`。
> 若显示 `wx6ac3f5090a6b99c5`（Cocos 默认示例 appid），说明构建时 appid 被覆盖了，
> 见下方「appid 有四个来源」。

### 1.1 appid 有四个来源，改一处不够（踩过一次）

Cocos 构建会按优先级合并以下来源，**后者覆盖前者**：

| 顺序 | 文件 | 是否入库 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | `settings/v2/packages/builder.json` | ✅ 已跟踪 | 项目级默认值（2 处） |
| 2 | `build-templates/wechatgame/project.config.json` | ✅ 已跟踪 | 构建模板，覆盖到产物 |
| 3 | **`profiles/v2/packages/wechatgame.json`** | ❌ **gitignored（本机）** | **用户级 profile，优先级最高** |
| 4 | `build/wechatgame/project.config.json` | ❌ gitignored | 最终产物 |

> 🔴 **第 3 项是隐形杀手**：它在 `.gitignore` 里（`profiles/`），不进版本库，
> 所以「仓库里看起来全改对了」但本机构建仍用旧 appid。
> 本项目首次构建就踩了这个坑 —— 产物里是 Cocos 默认的 `wx6ac3f5090a6b99c5`，
> 直接导致云环境列表同步失败（`ret: -80002`）。
>
> **改 appid 时三处同改**（第 1、2、3 项），然后重新构建。

---

## 阶段 1.5：首次打开就报错的排查（常见假故障）

刚导入项目时 DevTools 常刷出一串报错，**多数与你的代码无关**。逐条对照：

| 报错 | 性质 | 处理 |
| :--- | :--- | :--- |
| `[同步云环境列表] Base resp abnormal, {"ret":-80002}` | **真实问题** | appid 不对（见 §1.1）。改完**必须关闭项目重新导入**，DevTools 会缓存 appid |
| `app.json 中未定义自定义编译中指定的启动页面` | 工具残留状态 | 点「编译」旁的**编译模式下拉 → 选「普通编译」**。小游戏没有 app.json/pages，此错来自 DevTools 残留的小程序编译条件 |
| `[jsbridge] invoke getSystemInfo fail: jsbridge not ready` | 工具/引擎启动竞态 | 栈全在 `WAGame.js` 内（引擎启动读 deviceOrientation），**非你的代码**。清缓存后重新编译即可 |
| `Object.defineProperty called on non-object at ...xmldom/dom-parser (web-adapter.js)` | **基础库不兼容** | `web-adapter.js` 是 Cocos 引擎自带文件，其内置 xmldom polyfill 在灰度基础库下解析失败。**换掉灰度基础库**（见下） |
| `正在使用灰度中的基础库 3.17.3 进行调试` | 微信自己的警告 | 灰度库不稳定，微信明确提示「如有问题请更改基础库版本」 |

- [ ] 已确认 AppID = `wxd5cc731e7273d122`
- [ ] 编译模式已设为「普通编译」
- [ ] `详情 → 本地设置 → 调试基础库` 已**取消灰度版本**，改选一个正式版
- [ ] `工具 → 清除缓存 → 全部清除`，然后重新编译
- [ ] 若 appid 刚改过：**关闭项目 → 重新导入**（DevTools 缓存 appid，不重开不生效）

> 判断「是不是我的代码」的快捷方法：看报错栈里有没有 `assets/main/index.js`
> （Cocos 打包后的我们的代码）。栈全在 `WAGame.js` / `WAGameSubContext.js` /
> `web-adapter.js` 里 → 属于工具或引擎层。

---

## 阶段 2：云开发环境

- [ ] 顶部点 **云开发** 按钮 → 开通云开发（首次需实名，有免费额度）
- [ ] 创建/确认环境，环境 ID 为 **`cloud1-d7gp1em2efcf2b05b`**
      （代码里 `AppConfig.CLOUD_ENV` 已填此值，**不一致则必然失败**）

---

## 阶段 3：创建 5 个数据库集合

云开发控制台 → **数据库** → 点集合名旁 `+` → 输入名称 → 确定。**名称必须逐字一致**。

- [ ] `users`
- [ ] `rooms`
- [ ] `games_planehunt`
- [ ] `games_gomoku`
- [ ] `match_records`

### 3.1 立刻设置权限（最重要，配错会「静默失败」）

每个集合 → **权限设置**：

| 集合 | 权限 | 为什么 |
| :--- | :--- | :--- |
| `users` | 仅创建者可读写 | 用户资料与战绩统计 |
| `rooms` | **所有用户可读**，仅创建者可写 | 客户端必须 `watch` 监听；不可读 = 界面永不刷新且**无报错** |
| `games_planehunt` | **所有用户可读**，仅创建者可写 | 同上（含权威布局，只能读不能写） |
| `games_gomoku` | **所有用户可读**，仅创建者可写 | 同上 |
| `match_records` | 仅创建者可读写 | 战绩流水 |

- [ ] `users` 设为「仅创建者可读写」
- [ ] `rooms` 设为「所有用户可读」
- [ ] `games_planehunt` 设为「所有用户可读」
- [ ] `games_gomoku` 设为「所有用户可读」
- [ ] `match_records` 设为「仅创建者可读写」

> 🔴 **这是最容易埋雷的一步**：权限设错时 `watch` **不报错、不回调**，
> 表现为「对手准备了但我的界面不动」。查同步问题时**先回来确认这 5 项**。

---

## 阶段 4：创建索引（可后补，但建议现在做）

集合 → **索引管理** → 添加索引：

- [ ] `rooms`：`roomId`（**唯一**）
- [ ] `rooms`：`status` + `updatedAt`（复合，非唯一）
- [ ] `games_planehunt`：`roomId`（**唯一**）
- [ ] `games_gomoku`：`roomId`（**唯一**）
- [ ] `match_records`：`openid` + `createdAt`（复合）
- [ ] `users`：`openid`（**唯一**）← 登录时频繁 upsert，最重要

> 索引不影响功能正确性，只影响性能与并发安全（唯一索引能防重复文档）。
> **流程能跑通但偶发数据异常**时，回来检查唯一索引。

---

## 阶段 5：部署 9 个云函数

**云函数位置**：`C:\Users\war11\wechat_game\cloudfunctions\`

（注意它**不在** `build/wechatgame/` 里 —— 它在仓库根，与构建产物平级。
 DevTools 通过 `project.config.json` 的 `cloudfunctionRoot` 找到它，
 所以在工具左侧文件树里应能看到一个 `cloudfunctions` 目录，图标与普通目录不同。）

操作：在 DevTools 左侧文件树展开 `cloudfunctions` → 对每个函数目录
**右键 → 上传并部署：云端安装依赖** → 等待完成（首次 30~60 秒/个）。

- [ ] `login`
- [ ] `createRoom`
- [ ] `joinRoom`
- [ ] `ready`
- [ ] `startGame`
- [ ] `getRoomState`
- [ ] `planehunt_flip`
- [ ] `gomoku_move`
- [ ] `settleGame`

> 🔴 **不要部署 `common`**：`cloudfunctions/common/` 是**共享代码源**
> （只有 `index.js`，没有 `package.json`），不是云函数。
> 它的内容由 `tools/gen-cloudfunctions.js` 复制成每个函数目录内的 `common.js`，
> 部署 `common` 只会产生一个无用的云函数。
>
> ⚠️ 函数名必须与目录名**完全一致**（客户端按名调用，见 `config/Collections.ts` 的 `CLOUD_FUNCTIONS`）。
> ⚠️ 微信云函数**不能 require 上级目录**，每个目录里都有一份 `common.js` 副本 ——
> 如果以后改了 `cloudfunctions/common/index.js`，**必须重跑 `node tools/gen-cloudfunctions.js` 同步**，
> 然后重新部署受影响的函数。

验证部署成功：云开发控制台 → **云函数** → 列表里应出现这 9 个函数。
再回到模拟器看日志，预期出现：

```
[WxAuth] 登录成功 openid=oXXXX...
```

---

## 阶段 6：真机联调（核心验证）

### 6.1 基础链路

- [ ] 启动进入大厅，**控制台出现** `[WxAuth] 登录成功 openid=...`
- [ ] 云开发控制台 → `users` 集合 → 出现该 openid 的文档
- [ ] 大厅显示真实昵称（不再是「测试玩家」）
- [ ] 控制台出现 `[WxCloudService] 云环境初始化完成 env=cloud1-...`
- [ ] 顶部标题**不被状态栏/刘海遮挡**（刘海屏 iPhone 必测）
- [ ] 底部按钮不被 Home 条遮挡

### 6.2 房间链路（需要两个账号，可用「开发者工具 + 真机」组合）

- [ ] 建房返回 **6 位数字房间号**；`rooms` 集合出现文档
- [ ] 第二账号入房，两人**不会坐到同一座位**
- [ ] 一方点准备，另一方界面 **1 秒内**自动刷新准备状态（验证 watch 通了）
- [ ] 全员准备后房主可开局，双方**同时**进入对局界面
- [ ] 房主退出时房主**移交给另一玩家**

### 6.3 对局同步

- [ ] 五子棋：A 落子后 B 在 **500ms 内**看到棋子
- [ ] 寻机头：翻格结果双端一致
- [ ] 用非法坐标落子 → 云函数返回错误码且棋局不变（验证服务端权威）
- [ ] 对局结束弹结算，`match_records` 新增记录

### 6.4 分享与启动参数

- [ ] 房间内点「邀请好友」→ 弹出分享面板，卡片带正确房间号
- [ ] 好友点卡片**冷启动** → 直接落在该房间
- [ ] 小游戏退到后台 → 点**另一张**分享卡片 → **也能正确切房** ← 热启动分支，最易漏
- [ ] 从「最近使用」正常进入 → 落在大厅

### 6.5 断线重连（关键项）

- [ ] 对局中**断网 5 秒再恢复** → 棋局与对手**完全一致**（验证全量对账）
- [ ] 对局中切后台 10 秒再回前台 → 界面状态正确
- [ ] 杀进程重进 → 能恢复到原房间（`getRoomState` 兜底）

### 6.6 其它

- [ ] 落子/翻格有轻微振动（`vibrateShort`）
- [ ] 弱网冷启动（详情 → 性能 → 模拟弱网）→ 加载页显示进度，**不白屏**
- [ ] 首包 < 4MB（详情 → 基本信息）

---

## 阶段 7：上传与发布

- [ ] 工具右上角「上传」→ 填版本号与备注
- [ ] 微信公众平台 → 版本管理 → 提交审核
- [ ] （可选）设为体验版，邀请测试账号

---

## 常见问题速查

| 现象 | 根因 | 处理 |
| :--- | :--- | :--- |
| `game.json: ["workers"] 不能为 ''` | 构建模板有空字符串字段 | 已修复（提交 `cada124`），若复发检查 `build-templates/wechatgame/game.json` |
| **`module 'assets/internal/index.js' is not defined`** | **`packOptions.ignore` 误排除了构建产物里的 `assets/`** | 见 §1.0 红字。把 `packOptions.ignore` 置为 `[]` 后重新编译 |
| **`同步云环境列表 ret: -80002`** | **appid 被 `profiles/` 覆盖成 Cocos 默认值** | 见 §1.1，三处同改 appid 后**重新导入项目** |
| **`app.json 中未定义自定义编译中指定的启动页面`** | DevTools 残留的小程序编译条件 | 编译模式下拉 → 选「普通编译」 |
| **`jsbridge not ready` / `xmldom dom-parser` 报错** | 灰度基础库与 Cocos 适配层不兼容 | 换掉灰度基础库 + 清缓存重新编译 |
| `cloud init failed` | 环境 ID 错 / 未最早调用 init | 核对 `AppConfig.CLOUD_ENV` = `cloud1-d7gp1em2efcf2b05b` |
| `callFunction` 报 `-404011` | 云函数未部署或名称不符 | 确认 9 个函数都上传且名字一致 |
| **界面不刷新但无报错** | 集合权限未设「所有用户可读」 | **回阶段 3.1 检查 5 个集合权限** |
| watch 报「超出最大连接数」 | 未 close 旧 watcher | 检查离开房间时 `watchRoom` 的取消函数是否被调用 |
| 重连后棋子缺失 | 未做全量对账 | 确认 `AppBootstrap._hookReconnect()` 已生效（看日志有无「触发断线重连」） |
| 昵称显示「微信用户」 | `getUserProfile` 已受限 | 需做昵称填写 UI（`chooseAvatar` + `nickname`），当前为已知限制 |
| 分享面板不弹 | 未调 `showShareMenu` | 确认进入 Room 场景时调用了 `setPassiveShare` |
| 登录后仍显示测试玩家 | `USE_MOCK` 没切 / 没重新构建 | 确认 `USE_MOCK = false` 且已重新构建 |
| 数据错乱（跨账号） | Mock 与真实 openid 混用 | **清空本地缓存**（`API` 存储面板里删 `gg_user_info` / `gg_last_room`） |

---

## 已知限制（非缺陷，当前版本不做）

| 项 | 说明 |
| :--- | :--- |
| 昵称/头像 | `wx.getUserProfile` 已受限，需自绘昵称输入 UI；当前用「昵称首字 + 底色圆」占位 |
| 头像持久化 | 微信返回的头像是临时链接（约 3 天），需下载后传云存储换永久 fileID |
| 分享成功判定 | `shareAppMessage` 的 success 只代表面板拉起；精确判定依赖 `onShareMessageToFriend`，已接入但微信侧统计口径有限 |
| 美术资源 | 当前零外部资源（UI 全 `Graphics` 程序化绘制），加载页进度为分步推进而非真实资源比例 |
| 房间超时回收 | 服务端靠 `expireAt` + `getRoomState` 惰性判定；如需精确回收需配定时触发器 |

---

## 出问题时如何自查（省时间的三步）

1. **先看控制台日志的关键前缀**：
   `[WxCloudService]` / `[WxAuth]` / `[WxRoom]` / `[WxNetSync]` / `[LoadingScene]`
   —— 每个都带明确上下文，能直接定位到哪个服务出问题。
   **若报错栈里没有这些前缀、也没有 `assets/main/index.js`，说明是工具/引擎层问题，不是代码问题。**

2. **再查云开发控制台**：
   - 云函数 → 日志：看服务端有没有被调用、返什么错误码
   - 数据库 → 对应集合：看文档有没有按预期写入

3. **最后按优先级复核配置**（这三类是「代码全对但功能不通」的绝大多数原因）：
   `AppID 正确` → `集合权限` → `云函数部署` → `索引` → `调试基础库非灰度`

> 💡 三个最容易白费半天的坑，按此顺序排除：
> ① **AppID 被 `profiles/` 覆盖**（`.gitignore` 里，改仓库看不出来）
> ② **集合权限没设「所有用户可读」**（watch 静默失败，无任何报错）
> ③ **用了灰度基础库**（引擎适配层解析失败，报错全是工具内部的）
