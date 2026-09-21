# 微信联通清单（WECHAT INTEGRATION CHECKLIST）

> 本文件是第一阶段（编辑器内开发）与第二阶段（微信侧联通）之间的**交接契约**。
>
> 第一阶段交付：Mock 实现可全流程跑通 + Wx 桩（签名完整、方法体空、标注 `TODO(wechat-phase2)`）
> 第二阶段职责：在微信开发者工具中完成下表所有「联通步骤」，把 `AppConfig.USE_MOCK` 置为 `false`，真机联调。

---

## 0. 快速导航

| 序号 | 接口 | 桩文件 | 目标 wx API | 优先级 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `IPlatformService.getSystemInfo` | `assets/scripts/core/services/wx/WxPlatformService.ts` | `wx.getSystemInfoSync` | P0 |
| 2 | `IPlatformService.vibrateShort/Long` | 同上 | `wx.vibrateShort` / `wx.vibrateLong` | P2 |
| 3 | `IPlatformService.getLaunchOptions` | 同上 | `wx.getLaunchOptionsSync` | P1 |
| 4 | `IAuthService.login` | `wx/WxAuthService.ts` | `wx.login` + 云函数 `login` | P0 |
| 5 | `IAuthService.updateProfile` | 同上 | `wx.getUserProfile` / `open-type=chooseAvatar` | P2 |
| 6 | `IStorageService.get/set/remove` | `wx/WxStorageService.ts` | `wx.getStorageSync` 等 | P1 |
| 7 | `IShareService.shareRoom` | `wx/WxShareService.ts` | `wx.shareAppMessage` | P1 |
| 8 | `IShareService.setPassiveShare` | 同上 | `wx.onShareAppMessage` + `wx.showShareMenu` | P1 |
| 9 | `ICloudService.init` | `wx/WxCloudService.ts` | `wx.cloud.init` | P0 |
| 10 | `ICloudService.callFunction` | 同上 | `wx.cloud.callFunction` | P0 |
| 11 | `ICloudService.watchCollection` | 同上 | `wx.cloud.database().watch` | P0 |
| 12 | `IRoomService.*` | `wx/WxRoomService.ts` | 云函数 + `rooms` 集合 watch | P0 |
| 13 | `INetSyncService.*` | `wx/WxNetSyncService.ts` | 云函数 + 实时数据推送 | P0 |
| 14 | 检查更新 | `assets/scripts/core/services/wx/WxPlatformService.ts` (`checkUpdate`) + `LoadingScene._hookUpdateManager` | `wx.getUpdateManager` | **P0** |
| 15 | 首包体积守卫 | 构建配置（`build-templates/wechatgame/`） | — | P1 |

---

## 1. 详细联通表

### 1.1 系统信息与安全区（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IPlatformService.getSystemInfo(): SystemInfo` |
| **桩文件** | `assets/scripts/core/services/wx/WxPlatformService.ts` → `getSystemInfo()` |
| **目标 wx API** | `wx.getSystemInfoSync()` |
| **联通步骤** | 1. 实现方法体：`const info = wx.getSystemInfoSync();`<br>2. 字段映射：`screenWidth/screenHeight/pixelRatio/platform/SDKVersion` 直接取；<br>3. `safeArea` 映射为 `{ top, left, right, bottom, width, height }`（wx 原生结构与本项目 `SafeArea` 一致，直接透传）；<br>4. `statusBarHeight` 取 `info.statusBarHeight`；<br>5. `isMiniGame` 置 `true`；<br>6. 删除方法内的 `throw new Error(...)`。 |
| **验证方法** | ① 真机（iPhone 刘海屏 + 安卓全面屏各一台）启动，控制台打印 `[SafeAreaAdapter] 安全区适配完成：top=44 bottom=34 ...`；<br>② 顶部标题栏「游戏大厅」不被状态栏/刘海遮挡；<br>③ 底部「准备/开始游戏」按钮不被 Home 条遮挡；<br>④ 旋转设备（若开放横屏）或切换分屏时，`canvas-resize` 触发重新适配且无异常。 |
| **注意事项** | ① `wx.getSystemInfoSync` 已被官方标记为「不推荐」，但小游戏端仍可用；如需迁移，改用 `wx.getWindowInfo` + `wx.getDeviceInfo` 组合，注意 `safeArea` 在 `getWindowInfo` 中返回；<br>② 该接口是**同步**的，本接口设计为同步返回，故放在启动早期调用即可；<br>③ `safeArea` 在部分低版本基础库可能缺失，需兜底为「全屏」（本项目已在 `SafeAreaAdapter.apply()` 中做了 `isFinite` 与负数保护）。 |

### 1.2 振动反馈（P2）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IPlatformService.vibrateShort()` / `vibrateLong()` |
| **桩文件** | `WxPlatformService.ts` |
| **目标 wx API** | `wx.vibrateShort({ type: 'light' \| 'medium' \| 'heavy' })` / `wx.vibrateLong()` |
| **联通步骤** | 实现方法体为 `wx.vibrateShort({ type: 'light' })` 与 `wx.vibrateLong()`；需在 `game.json` 或不需要额外权限（振动无需授权）。 |
| **验证方法** | 真机对局中点击棋盘落子/翻格有轻微振动；结算弹窗弹出时有长振动。 |
| **注意事项** | ① 部分安卓机型不支持 `type` 参数，会走默认强度，属正常；<br>② `vibrateShort` 调用间隔 < 30ms 会被系统忽略，快速连点时不保证每次都振动；<br>③ iOS 需在「设置-声音与触感」中开启振动开关，代码无法强制。 |

### 1.3 启动参数（P1，分享直达房间）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IPlatformService.getLaunchOptions()` |
| **桩文件** | `WxPlatformService.ts` |
| **目标 wx API** | `wx.getLaunchOptionsSync()`（冷启动）+ `wx.onShow(cb)`（热启动） |
| **联通步骤** | 1. 实现 `getLaunchOptions()` 返回 `wx.getLaunchOptionsSync()` 的 `{ scene, query, shareTicket, referrerInfo }`；<br>2. **补充**：在 `AppBootstrap` 或 Lobby 中注册 `wx.onShow((res) => ...)`，处理「App 已在后台时从分享卡片再次进入」的场景 —— 此时 `getLaunchOptionsSync` 不会更新，必须靠 `onShow`；<br>3. 解析 `query.roomId` / `query.gameId` 后调用 `uiManager.gotoRoom({ ..., joinRoomId })`（LoadingScene 中已有此逻辑）。 |
| **验证方法** | ① 让好友分享房间卡片，从卡片冷启动 → 直接落在该房间；<br>② 小游戏退到后台，再点另一张分享卡片 → 也能正确切房（验证 `onShow` 分支）；<br>③ 正常从「最近使用」进入 → 落在 Lobby。 |
| **注意事项** | ① `query` 中的值全部是**字符串**，`roomId` 需按字符串处理（本项目 `joinRoom` 已做 `^\d{6}$` 正则校验）；<br>② `scene=1044` 表示带 `shareTicket` 的群聊卡片，如需群排行需额外 `wx.getShareInfo`；<br>③ **热启动分支容易漏做**，是本项最常见的线上问题。 |

### 1.4 静默登录（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IAuthService.login(): Promise<UserInfo>` |
| **桩文件** | `assets/scripts/core/services/wx/WxAuthService.ts` |
| **目标 wx API** | 云函数 `login`（内部用 `cloud.getWXContext().OPENID`） |
| **联通步骤** | 1. **部署 `cloudfunctions/login`**（源码已交付）；<br>2. 实现方法体：<br>`const res = await wx.cloud.callFunction({ name: 'login', data: { nickname, avatarUrl } });`<br>`this._user = { openid: res.result.data.openid, ... };`<br>3. 把 `_user` 写入 `IStorageService`（key = `STORAGE_KEYS.USER_INFO`）作为冷启动兜底；<br>4. 删除 `throw new Error(...)`。 |
| **验证方法** | ① 真机启动控制台打印 `openid=xxx`；<br>② 微信云开发控制台 → 数据库 → `users` 集合出现该 openid 的文档；<br>③ 第二次启动（有缓存）仍能快速进入大厅，昵称显示正确。 |
| **注意事项** | ① **不需要** `wx.login` 拿 code 再 `code2Session` —— 云函数内 `cloud.getWXContext().OPENID` 由微信服务端注入，无法伪造，这是云开发标准做法（本项目采用此方案）；<br>② `openid` 是**本项目全链路的主键**（座位、棋步、战绩都用它），第一阶段 Mock 用的是固定值 `mock-openid-0001`，切真机后数据不可混用，需清空本地缓存（`STORAGE_KEYS.USER_INFO` / `LAST_ROOM`）；<br>③ 云函数首次调用有冷启动（约 1-3s），Loading 页需能容忍，本项目已有 120ms Mock 延迟 + 进度提示，真机可加 loading 态。 |

### 1.5 昵称与头像（P2）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IAuthService.updateProfile(nickname, avatarUrl)` |
| **桩文件** | `WxAuthService.ts` |
| **目标 wx API** | `wx.getUserProfile`（已受限）/ `<button open-type="chooseAvatar">` + `<input type="nickname">` |
| **联通步骤** | 1. 注意：`wx.getUserProfile` 自 2022-10-25 起在**新注册**小程序中返回匿名数据（昵称统一为「微信用户」、头像为默认灰头像）；<br>2. 推荐改用「头像昵称填写能力」：`<button open-type="chooseAvatar" bind:chooseavatar>` 与 `<input type="nickname">`；<br>3. 小游戏内无 WXML，需用 `wx.createSelectorQuery` 或直接让用户在小游戏自绘 UI 中输入，拿到后调云函数 `login` 更新 `users`。 |
| **验证方法** | 真机修改昵称后，`users` 集合中该文档 `nickname` 字段更新，返回大厅后显示新昵称。 |
| **注意事项** | ① 头像 URL 是**临时链接**（有效期约 3 天），需下载后上传到云存储换永久 fileID，否则过期后显示裂图；本项目 `avatarUrl` 字段已预留，第二阶段建议改为存 `cloud://` fileID；<br>② 本项目为简化 UI，头像当前用「昵称首字 + 底色圆」占位（`UIFactory.createAvatar`），美术资源到位后替换。 |

### 1.6 本地存储（P1）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IStorageService.get/set/remove/clear` |
| **桩文件** | `assets/scripts/core/services/wx/WxStorageService.ts` |
| **目标 wx API** | `wx.getStorageSync` / `wx.setStorageSync` / `wx.removeStorageSync` / `wx.clearStorageSync` |
| **联通步骤** | 见桩文件内 TODO。**关键**：`wx.getStorageSync` 读取不存在的 key 返回 `''`（空字符串），不是 `undefined`，必须显式判空后再返回 `defaultValue`。 |
| **验证方法** | ① 真机设置后杀进程重进，数据仍在；<br>② 首次启动无缓存时，登录流程正常回落到默认值（不出现 `null` 崩溃）。 |
| **注意事项** | ① 单个 key 上限 **1MB**，全部数据上限 **10MB**，超限会抛异常；战绩等大数组建议只存摘要或改存云端；<br>② 存储是**同步**的，大数据量会阻塞主线程，本项目仅在启动与登录时读写，影响可控。 |

### 1.7 分享（P1）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IShareService.shareRoom` / `onShareResult` / `setPassiveShare` |
| **桩文件** | `assets/scripts/core/services/wx/WxShareService.ts` |
| **目标 wx API** | `wx.shareAppMessage` / `wx.onShareAppMessage` / `wx.showShareMenu` / `wx.onShareMessageToFriend` |
| **联通步骤** | 1. 主动分享：`wx.shareAppMessage({ title, imageUrl, query: 'roomId=xxx&gameId=xxx' })`；<br>2. 被动转发：`wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage','shareTimeline'] })` + `wx.onShareAppMessage(() => ({ title, query }))`；<br>3. 分享结果：`wx.onShareMessageToFriend`（需要 `withShareTicket`）或依赖卡片被点击后的启动 query。 |
| **验证方法** | ① 真机点「邀请好友」弹出分享面板，卡片带正确房间号；<br>② 好友点卡片能直进该房间（与 1.3 联动验证）；<br>③ 真机分享后回调被触发且无异常日志。 |
| **注意事项** | ① **`shareAppMessage` 的 `success` 回调仅代表面板已拉起，不代表用户真的分享成功** —— 不能据此发奖励（会被刷）；要准确判定需走 `onShareMessageToFriend` 或统计卡片点击；<br>② `query` 长度上限 1024 字符；<br>③ 分享图片建议 ≤ 300KB（5:4 比例），过大会导致分享失败；<br>④ `menus` 需在用户点击右上角**之前**调用 `showShareMenu` 才生效（本项目在进入 Room 时调用，符合要求）。 |

### 1.8 云开发初始化（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `ICloudService.init()` |
| **桩文件** | `assets/scripts/core/services/wx/WxCloudService.ts` |
| **目标 wx API** | `wx.cloud.init({ env, traceUser })` |
| **联通步骤** | 1. 在云开发控制台创建环境，得到环境 ID；<br>2. 把 `AppConfig.CLOUD_ENV = 'TODO'` 改为真实环境 ID；<br>3. 实现 `init()` 调用 `wx.cloud.init({ env: AppConfig.CLOUD_ENV, traceUser: true })`；<br>4. 确认 `AppBootstrap` 在最早时机调用（当前已在 `onLoad` 第 3 步）。 |
| **验证方法** | 真机控制台无 `cloud init failed`；后续 `callFunction` 返回正常。 |
| **注意事项** | ① **必须在任何 `callFunction` / 数据库操作之前**调用，否则报错；<br>② `AppConfig.CLOUD_ENV` 是 `readonly`，第二阶段需改源码（或改为从 `wx.cloud.DYNAMIC_CURRENT_ENV` 取值，本项目服务端已用 `DYNAMIC_CURRENT_ENV`）；<br>③ 一个游戏可有多个环境（测试/正式），切换时注意数据隔离。 |

### 1.9 云函数调用（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `ICloudService.callFunction<TReq, TRes>(name, data)` |
| **桩文件** | `WxCloudService.ts` |
| **目标 wx API** | `wx.cloud.callFunction({ name, data })` |
| **联通步骤** | 1. 实现：`const res = await wx.cloud.callFunction({ name, data }); return res.result as TRes;`；<br>2. **逐个部署 9 个云函数**（见 `cloudfunctions/`，每个目录需 `npm install` 后上传部署，或用「云端安装依赖」）；<br>3. 部署时「云函数目录」选 `cloudfunctions/<name>`。 |
| **验证方法** | 真机调用 `login` 返回 openid；调用 `createRoom` 后 `rooms` 集合出现文档。 |
| **注意事项** | ① 返回值必须**可 JSON 序列化**（`Date`/`undefined` 会丢失）；<br>② 单次返回值上限 **1MB**，大列表必须分页；<br>③ 每个云函数目录需独立 `package.json`（本项目已通过 `tools/gen-cloudfunctions.js` 生成，含 `wx-server-sdk` 依赖）；<br>④ 本项目 `common.js` 已复制到每个函数目录（微信云函数**不能 require 上级目录**）。 |

### 1.10 实时数据监听（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `ICloudService.watchCollection(name, query, cb)` |
| **桩文件** | `WxCloudService.ts` |
| **目标 wx API** | `wx.cloud.database().collection(name).where(query).watch({ onChange, onError })` |
| **联通步骤** | 1. 实现：创建 watcher，`onChange` 中把 `snapshot.docs` 交给 `cb`；返回 `() => watcher.close()`；<br>2. 在云开发控制台把 `rooms` 集合权限设为「所有用户可读」（或按 `_openid` 读写）。 |
| **验证方法** | ① 真机两个账号在同一房间，A 点准备后 B 界面 1 秒内更新；<br>② A 开局后 B 自动进入对局界面。 |
| **注意事项** | ① **每个客户端最多 5 个 watch 连接**，超出报错 —— 因此本项目设计为「对局中只保留当前房间一个 watch」，离开房间必须 `close()`（`WxCloudService.watchCollection` 返回的取消函数已支持）；<br>② watch 断线会**自动重连但只推增量**，重连后必须调 `getRoomState` 做一次全量对账（断线重连补偿），否则会丢棋步 —— 这是本项目 `INetSyncService.reconnect()` 的设计要求；<br>③ 集合权限配置错误会导致 watch **静默失败**（无报错但无回调），排查时优先检查此处。 |

### 1.11 房间服务（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IRoomService.createRoom / joinRoom / leaveRoom / setReady / startRoom / watchRoom / getRoomState / sendRoomMessage` |
| **桩文件** | `wx/WxRoomService.ts` |
| **目标 wx API** | 云函数 `createRoom` / `joinRoom` / `ready` / `startGame` / `getRoomState` + `rooms` 集合 watch |
| **联通步骤** | 逐个实现（桩文件内每个方法都有详细 TODO 与错误码约定）：<br>- `createRoom` → `cloudfunctions/createRoom`<br>- `joinRoom` → `cloudfunctions/joinRoom`（`action:'join'`）<br>- `leaveRoom` → `cloudfunctions/joinRoom`（`action:'leave'`）<br>- `setReady` → `cloudfunctions/ready`<br>- `startRoom` → `cloudfunctions/startGame`<br>- `watchRoom` → `watchCollection(COLLECTIONS.ROOMS, { roomId }, cb)`<br>- `getRoomState` → `cloudfunctions/getRoomState` |
| **验证方法** | ① 建房返回 6 位房间号，`rooms` 集合出现文档；<br>② 两账号同时加入同一房间不会坐到同一座位（并发保护）；<br>③ 全员准备后房主可开局，双方同时进入对局；<br>④ 房主退出时房主移交给另一玩家；<br>⑤ 杀进程重进能恢复到原房间（`getRoomState` 兜底）。 |
| **注意事项** | ① **房间号碰撞**：服务端已实现「查询去重 + 最多重试 10 次」；<br>② **并发占座**：服务端用「更新条件带 `seats.<i>.playerId: ''`」的乐观锁，竞争失败会重试，客户端只需处理最终结果；<br>③ **错误码约定**（与 `cloudfunctions/common/index.js` 的 `ERR` 一致）：`4001` 房间不存在、`4002` 房间已满、`4003` 已开局、`4004` 已解散、`4005` 非房主、`4006` 未全员准备、`4007` 非法操作、`4008` 未轮到你；<br>④ **AI 练习（practice=true）建议不走云函数**，纯客户端本地进行以省资源、降延迟（当前 Mock 实现已如此，真机阶段请保持）。 |

### 1.12 对局同步（P0）

| 项 | 内容 |
| :--- | :--- |
| **接口** | `INetSyncService.connect / send / onMessage / disconnect / reconnect / getStatus` |
| **桩文件** | `wx/WxNetSyncService.ts` |
| **目标 wx API** | `wx.cloud.callFunction`（上行）+ `watch`（下行），或云托管 WebSocket |
| **联通步骤** | 见 `docs/REALTIME_CHANNEL_DECISION.md` 的选型结论；在本文件中实现：<br>1. `send(cmd, payload)` → 调对应云函数（如 `gomoku_move` / `planehunt_flip`）；<br>2. `connect(roomId)` → watch 对局集合（`games_gomoku` / `games_planehunt`），把新增棋步转成 `NetMessage` 回调；<br>3. `reconnect()` → 重建 watch + 调 `getRoomState` 全量对账；<br>4. `getStatus()` 由 socket/watch 生命周期维护。 |
| **验证方法** | ① 两账号对局，A 落子后 B 在 500ms 内看到棋子；<br>② 对局中断网 5 秒再恢复，棋局与对手完全一致（**关键**：验证全量对账）；<br>③ 用非法坐标落子，云函数返回错误码且棋局不变（验证服务端权威）。 |
| **注意事项** | ① **上行必须走云函数而非客户端直写数据库** —— 客户端直写无法防作弊（改前端即可伪造棋步）；<br>② **消息幂等**：重连后可能收到重复棋步，业务层已按 `reqSeq` / 位置去重（`GomokuGame._applyMoveResult` 与 `PlaneHuntGame._applyFlipResult` 均做了幂等判断），服务端也需保证写入幂等；<br>③ **寻机头的布局绝不下发客户端**：只通过 `planehunt_flip` 逐格查询结果，这是本项目防篡改的核心设计（`WxNetSyncService` 实现时**不要**把 `games_planehunt.cells` 下发给客户端）；<br>④ 触发重连的时机：`wx.onShow`（切回前台）与 `wx.onNetworkStatusChange`。 |

### 1.13 检查更新与「明确的加载页」（P0）

> ⚠️ **加载页不是可选装饰，是微信小游戏的硬要求。**
> 小游戏冷启动需先下载代码包 + 初始化引擎，这段时间屏幕上本来是空的；
> 若不提供带进度反馈的加载页，用户看到白屏/黑屏，会被判「无响应」。

| 项 | 内容 |
| :--- | :--- |
| **接口** | `IPlatformService.checkUpdate?(handlers)`（走 `core/services` 抽象，业务层零 `wx.*` 调用） |
| **桩文件** | `assets/scripts/core/services/wx/WxPlatformService.ts` → `checkUpdate()` |
| **目标 wx API** | `wx.getUpdateManager()` |
| **加载页位置** | `assets/scenes/Loading.scene`（起始场景）+ `assets/scripts/lobby/LoadingScene.ts` + `tools/ui-trees.js` 的 `loadingTree()` |
| **联通步骤** | 1. 实现 `WxPlatformService.checkUpdate()`：<br>`const um = wx.getUpdateManager();`<br>`um.onCheckForUpdate(res => { if (res.hasUpdate) handlers.onHasUpdate?.(); });`<br>`um.onUpdateReady(() => handlers.onUpdateReady?.(() => um.applyUpdate()));`<br>`um.onUpdateFailed(() => handlers.onUpdateFailed?.());`<br>2. 确认 `LoadingScene._hookUpdateManager()` 在启动早期被调用（当前在 `_boot()` 第 5 阶段）；<br>3. **把 `_preload()` 接上真实资源**：有美术资源后改为 `resources.loadDir(path, onProgress)`，让进度条反映真实加载比例（当前零资源项目为分步推进）；<br>4. 删除 `WxPlatformService.checkUpdate()` 里的占位日志。 |
| **验证方法** | ① **弱网/冷启动**（`微信开发者工具 → 详情 → 性能 → 模拟弱网`）真机启动，加载页明确显示进度百分比与阶段文案，**不出现无反馈白屏**；<br>② 上传新版本后旧版本启动 → `Hint` 显示「发现新版本，正在下载…」→ 下载完成弹出「版本更新 / 立即重启更新」弹窗；<br>③ 点「立即重启更新」后重启进入新版本；点「稍后再说」可继续游戏；<br>④ 首次上传的版本**不触发**更新流程（属正常）；<br>⑤ 断网启动 → 8 秒后 `Hint` 显示「加载较慢，请检查网络后重试」，不静默卡死。 |
| **注意事项** | ① 小游戏**不支持强制更新**，`applyUpdate()` 必须由用户在弹窗确认后触发（本项目已在 Loading 页做成选项弹窗）；<br>② 更新检查要在启动**最早时机**注册，越早越能覆盖热启动拿到新版本的情况；<br>③ 加载页 UI 是**静态节点**（写在 `tools/ui-trees.js`），控制器只按路径绑定 —— 改加载页请改 `loadingTree()` 并重跑 `node tools/gen-scenes.js`；<br>④ 进度条必须**只增不减**（`LoadingScene._advance` 已保证），回退会让用户误以为卡死；<br>⑤ 起始场景必须是 `Loading`（构建面板 → 起始场景），否则加载页不会出现。 |

### 1.14 首包体积守卫（P1）

| 项 | 内容 |
| :--- | :--- |
| **接口** | 无（构建配置） |
| **配置位置** | `build-templates/wechatgame/game.json`、`settings/v2/packages/builder.json`、`settings/v2/packages/engine.json` |
| **目标** | 首包 ≤ 4MB |
| **联通步骤** | 1. 构建后在微信开发者工具「详情 → 基本信息」查看包体；<br>2. 超限则把音频/大图移入**分包**或远程 CDN：`builder.json` 的 `wechatgame.subpackages` 与 `remoteServerAddress` 已预留字段；<br>3. 引擎模块裁剪已在 `engine.json` 关闭 3D/物理/Terrain 等（见基线清单）。 |
| **验证方法** | 构建产物首包 < 4MB；微信开发者工具无「代码包超过限制」警告。 |
| **注意事项** | ① 主包上限 4MB，总包上限 30MB（含分包）；<br>② 本项目当前**零外部美术资源**（UI 全部用 `Graphics` + `Label` 程序化绘制），首包非常小，超限风险低。 |

---

## 2. 第二阶段操作手册（Step by Step）

### 前置条件

- 已完成第一阶段，编辑器预览全流程可玩（见 `docs/SELF_TEST_CHECKLIST.md`）
- 已注册微信小游戏账号，拿到 **AppID**
- 已安装**微信开发者工具**（稳定版）

### 步骤 1：构建微信小游戏包

1. 打开 Cocos Creator 3.8.8，加载本项目
2. 菜单 `项目 → 构建发布`
3. 平台选 **微信小游戏**
4. 配置：
   - 游戏名称：`沙发派对`
   - 起始场景：`Loading`（本项目 `assets/scenes/Loading.scene`）
   - 设备方向：`portrait`
   - 填 AppID（或先留空，用测试号）
5. 点「构建」→ 产物在 `build/wechatgame/`

> ⚠️ 本项目已提供 `build-templates/wechatgame/game.json` 与 `project.config.json`，
> 构建时会自动合并，**不要**手工覆盖（如需改 appid 请改模板或构建面板）。

### 步骤 2：在微信开发者工具中打开

1. 打开微信开发者工具 → `导入项目`
2. 目录选 `build/wechatgame/`
3. AppID 填自己的小游戏 AppID
4. 项目类型：**小游戏**

### 步骤 3：创建云开发环境

1. 微信开发者工具 → 顶部 `云开发` 按钮 → 开通（首次需实名/付费套餐，有免费额度）
2. 创建环境，记下**环境 ID**（形如 `xxx-1a2b3c`）
3. 修改 `assets/scripts/config/AppConfig.ts`：
   ```ts
   public static readonly CLOUD_ENV = '你的环境ID';   // 原为 'TODO'
   public static readonly WX_APPID = 'wxd5cc731e7273d122';  // ✅ 已填真实 AppID
   ```
   > appid 另需与 `settings/v2/packages/builder.json`（`wechatgame.appid` +
   > `packages.wechatgame.appid`）及 `build-templates/wechatgame/project.config.json`
   > 保持一致，四处已统一为 `wxd5cc731e7273d122`。
   > **注意**：微信开发者工具会改写 `build/wechatgame/project.config.json` 的 appid／
   > 生成 `project.private.config.json`，但 `build/` 每次构建会被清空 —— 所以**只改
   > `build-templates/` 与 `settings/`**，不要在 `build/` 里做不可再生的改动。
4. 重新构建（步骤 1）

### 步骤 4：创建数据库集合

在云开发控制台 → 数据库 → 新建以下 **5 个集合**（权限按表配置）：

| 集合 | 权限设置 | 说明 |
| :--- | :--- | :--- |
| `users` | 仅创建者可读写 | 用户资料与战绩统计 |
| `rooms` | 所有用户可读，仅管理端可写 | 房间状态（客户端需 watch，故必须可读） |
| `games_planehunt` | 所有用户可读，仅管理端可写 | 寻机头对局（**含权威布局，务必只读**） |
| `games_gomoku` | 所有用户可读，仅管理端可写 | 五子棋对局 |
| `match_records` | 仅创建者可读写 | 战绩流水 |

**建议索引**（提升查询性能）：

| 集合 | 索引字段 | 类型 |
| :--- | :--- | :--- |
| `rooms` | `roomId` | 唯一索引 |
| `rooms` | `status` + `updatedAt` | 复合索引（清理任务用） |
| `games_planehunt` | `roomId` | 唯一索引 |
| `games_gomoku` | `roomId` | 唯一索引 |
| `match_records` | `openid` + `createdAt` | 复合索引 |
| `users` | `openid` | 唯一索引 |

> 详细字段设计见 `docs/CLOUD_DESIGN.md`。

### 步骤 5：部署云函数

对 `cloudfunctions/` 下 **9 个目录**逐个执行：

1. 右键目录（如 `login`）→ `上传并部署：云端安装依赖`
2. 等待部署完成（首次约 30-60 秒）
3. 重复 9 次：`login`、`createRoom`、`joinRoom`、`ready`、`startGame`、`getRoomState`、`planehunt_flip`、`gomoku_move`、`settleGame`

> ⚠️ 每个目录已含独立 `package.json`（依赖 `wx-server-sdk`）与 `common.js` 副本。
> 微信云函数**不能 require 上级目录**，所以公共代码是复制而非共享 —— 修改 `cloudfunctions/common/index.js` 后需重新运行 `node tools/gen-cloudfunctions.js` 同步。

### 步骤 6：切换真实实现

修改 `assets/scripts/config/AppConfig.ts`：

```ts
public static USE_MOCK = false;   // ← 唯一需要改的开关
```

重新构建并上传。此时 `ServiceLocator` 会自动注入全部 `Wx*` 实现，业务层零改动。

### 步骤 7：真机联调

按下方清单逐项验证（每项都能在对应接口的「验证方法」中找到详细步骤）：

- [ ] 启动进入大厅（`getSystemInfo` + `login`）
- [ ] 顶部/底部不被刘海与 Home 条遮挡（`safeArea`）
- [ ] 大厅显示真实昵称（`login` 返回）
- [ ] 建房得到 6 位房间号（`createRoom`）
- [ ] 邀请好友分享成功，好友点卡片直进房间（`shareAppMessage` + `getLaunchOptions`）
- [ ] 双方准备 → 房主开局 → 双方同时进入对局（`ready` + `startGame` + `watch`）
- [ ] 落子/翻格实时同步（云函数 + `watch`）
- [ ] 断网 5 秒恢复后棋局一致（`reconnect` 全量对账）
- [ ] 对局结束弹出结算，`match_records` 有新记录（`settleGame`）
- [ ] 杀进程重进能恢复房间（`getRoomState`）
- [ ] 振动反馈正常（`vibrateShort`）
- [ ] 首包 < 4MB（构建面板查看）

### 步骤 8：常见问题排查

| 现象 | 可能原因 | 排查方向 |
| :--- | :--- | :--- |
| `cloud init failed` | 环境 ID 错误或未调用 init | 检查 `AppConfig.CLOUD_ENV`，确认 `init()` 在最早时机 |
| `callFunction` 报 `-404011` | 云函数未部署或名称不符 | 确认 9 个函数都已上传，名称与 `COLLECTIONS`/`CLOUD_FUNCTIONS` 一致 |
| watch 无回调且无报错 | 集合权限未设「所有用户可读」 | 云开发控制台检查 `rooms` 权限 |
| watch 报「超出最大连接数」 | 未 close 旧 watcher | 检查离开房间/切场景时是否调用了取消订阅函数 |
| 重连后棋子缺失 | 未做全量对账 | `reconnect()` 中必须调 `getRoomState` |
| 昵称显示「微信用户」 | `getUserProfile` 已受限 | 改用 `chooseAvatar` + `nickname` 输入组件 |
| 分享面板不弹 | 未调 `showShareMenu` 或图片过大 | 检查 `setPassiveShare` 调用时机与图片大小 |
| 存储读取到空字符串 | `getStorageSync` 返回 `''` 而非 `undefined` | 按 `WxStorageService` 的 TODO 显式判空 |

---

## 3. 阶段边界确认

### 第一阶段（已完成）

- ✅ 全部平台能力经 `core/services/` 抽象层接口调用，业务层**零 `wx.*` 直接调用**
- ✅ Mock 实现可在编辑器预览中全流程跑通
- ✅ 每个接口都有 Wx 桩 + `TODO(wechat-phase2)` 注释
- ✅ 本清单覆盖全部 15 项联通点（接口 → wx API → 桩位置 → 步骤 → 验证）
- ✅ 云函数源码、集合设计、消息协议文档齐备

### 第二阶段（代码侧已完成，**状态：未验证**）

> **进度：7 个 Wx 服务已全部实现，`TODO(wechat-phase2)` 计数 42 → 0。
> 剩余工作是「微信开发者工具侧的配置与真机验证」，见 `docs/WECHAT_PHASE2_CHECKLIST.md`。**
>
> ⚠️ **未验证声明**：以下改动均通过自动校验（typecheck / 单测 52 项 / 场景校验 /
> 云函数语法 / 边界铁律），但**未经过真机验证** —— 未在微信开发者工具中构建过、
> 未部署云函数、未创建集合、未做真机联调。
> 对应 git 标签：`wechat-phase2-unverified`。

已做：

- ✅ `AppConfig` 填入真实 `WX_APPID` / `CLOUD_ENV`，`USE_MOCK` 已置 `false`
- ✅ 7 个 Wx 服务（`WxPlatform / WxAuth / WxStorage / WxShare / WxRoom / WxNetSync / WxCloud`）
      全部实现，共 42 处 TODO 清零
- ✅ 新增 `config/CloudErrors.ts`：错误码表与 `CloudError` 类型，
      与 `cloudfunctions/common/index.js` 的 `ERR` 严格对齐
- ✅ 新增 `.typecheck/wx-shim.d.ts`：`wx` 全局 API 最小类型声明
      （本仓库无 minigame-api-typings，缺此文件无法通过严格模式校验）
- ✅ 补上清单 §1.3 标注「最容易漏」的**热启动分支**：
      `IPlatformService.subscribeShow()`（wx.onShow）+ LoadingScene `_hookShowListener()`
- ✅ 补上 §1.12 要求的**断线重连触发**：
      AppBootstrap `_hookReconnect()`（onShow + 网络恢复），经抽象层不直调 wx.*
- ✅ 边界铁律保持：全部真实 `wx.*` 调用仅存在于 `core/services/wx/` 五个文件

未做（需人工在微信侧操作，无法由代码完成）：

- ❌ 微信开发者工具中的云环境开通、集合创建、索引配置
- ❌ 9 个云函数的上传部署
- ❌ 真机联调与体验版上传

---

## 4. 实现与原桩设计的差异说明（重要）

| 项 | 原桩注释 | 实际实现 | 原因 |
| :--- | :--- | :--- | :--- |
| 登录换取 openid | `wx.login` 拿 code → `code2Session` | 云函数内 `cloud.getWXContext().OPENID` | 后者是云开发标准做法，OPENID 由微信服务端注入不可伪造；两者互斥，云函数源码用的是后者 |
| `updateProfile` | 调 `wx.getUserProfile` | 不调用，透传调用方收集的昵称/头像 | `getUserProfile` 自 2022-10-25 起对新注册小程序返回匿名数据 |
| `getSystemInfo` | 仅 `wx.getSystemInfoSync` | 优先 `getWindowInfo`+`getDeviceInfo`，回落 | 官方已将 `getSystemInfoSync` 标记为不推荐 |
| `checkUpdate` | 桩内占位日志 | 接 `wx.getUpdateManager` | 补齐清单 §1.13 |
| 分享成功判定 | 依赖 `shareAppMessage` success | 语义标注为「面板已拉起」+ `onShareMessageToFriend` | success 不代表分享成功，据此发奖会被刷 |
| 热启动 | 未提及具体接入点 | `subscribeShow()` + LoadingScene 注册 | 清单 §1.3 明确要求，且为最常见线上问题 |
| 断线重连触发 | 未提及 | AppBootstrap 注册 onShow + 网络恢复 | 清单 §1.12 明确要求 |
