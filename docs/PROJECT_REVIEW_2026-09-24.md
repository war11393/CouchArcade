# 项目整体检查报告 —《沙发派对》

日期：2026-09-24　范围：客户端 48 个 TS（约 13k 行）+ 9 个云函数 + 23 个工具脚本
方法：3 个子代理并行审查 + 自查（**所有结论都经我复核或实测**；子代理臆造的条目已剔除，见文末）

---

## 一、高优先级（功能不正确 / 数据错误）

### H1. `settleGame` 无幂等 → 战绩重复累加【已实测确证】
**证据（我用内存库桩跑真实云函数）**：同一房间调用两次 → `match_records` **4 条**（应为 2），玩家 `winCount` = **2**（应为 1）。

**两条真实触发路径**：
1. **投降双写**：`GomokuGame.surrender()` 发 `GAME_SURRENDER` → `WxNetSyncService.ts:170-175` 把它映射为 `settleGame` 调用；结算时 `StatsService.ts:72` **又调一次** `settleGame`。
2. 任何重复结算（场景未重载的旧版本、连点）。

**修复**：`settleGame/index.js` 开头加短路——房间已 `finished` 且有 `finishedAt`（该字段已存在，105 行）则直接返回既有结果，不再写库。极小改动。

### H2. 寻机头与五子棋不对称：五子棋的手感修复，寻机头一样没享受到【已核实】
| 机制 | 五子棋 | 寻机头 |
| :--- | :--- | :--- |
| `_predicted`（本地预落子） | 8 处 | **0** |
| `_rollbackLocal`（拒子回滚） | 4 处 | **0** |
| `_commitOpponentMove`（延迟落子） | 3 处 | **0** |
| `AI_MIN_THINK_MS`（最小思考间隔） | 2 处 | **0** |

后果：寻机头点格后要等完整网络往返（含 AI 回手）才翻开，手感明显迟滞。
（注：寻机头**不**乐观落子，所以不存在状态分叉风险 —— 这一点反而安全。）

### H3. `planehunt_flip` 云函数仍是旧规则（翻中机头连翻）【已实测确证】
**证据**：人类翻中机头 → 服务端 `nextPlayerId` = **人类自己**（`planehunt_flip/index.js:107` `extraTurn = scored && !finished`），而客户端 `PlaneHuntRules.ts:249` 已改为「翻到机头也换手」。
后果：回合判定错位 → 真机寻机头「点了没反应」（与五子棋 `gameId` 那个 bug 同款症状）。

---

## 二、中优先级（健壮性 / 工程质量）

### M1. watch 出错后不会自愈
`WxNetSyncService.ts:341-345` 的 `onError` 只把状态置为 `RECONNECTING`，而 `reconnect()` **仅由 `wx.onShow` / 网络恢复事件触发**。若玩家一直停在游戏页且 watch 出错，界面会停住直到切后台再回来。
建议：`onError` 里加一次延迟重试（退避），或让 `WATCH_ACK_TIMEOUT` 看门狗触发 `reconnect()`。

### M2. `RoomScene._onShare()` 从未绑定 → 房间页分享功能是死的
`RoomScene.ts:464` 定义了 `_onShare()`，但 `_bindNodes()`（118-119 行）只绑了 `BtnReady` / `BtnLeave`，没有分享按钮的 `bindClick`。

### M3. 自检漏掉「未使用代码」这一整类 → 26 处死代码
`tsconfig.check.json` 开了 `strict` 但**没开** `noUnusedLocals` / `noUnusedParameters`。打开后一次报出 26 处，例如：
- `GameScene.ts:12-18`：`Vec3` / `view` / `AiLevel` / `requireGameMeta` / `Cmd` / `UiManagerRefStub` 六个无用导入
- `UIManager.ts:17,43,49`：`Component` / `makeFullScreen` / `ccclass`
- `WxNetSyncService.ts:19`：`CloudError`
- `PlaneHuntBoard.ts:130-132`：`_myPlayerId` / `_firstPlayerId` / `_isMyTurn` 三个字段
建议：把这两个开关加进自检，清掉现有 26 处。

### M4. 完全没有联机（pvp）全流程测试
11 个测试文件、约 250 断言，**全部是 AI 练习 / 算法 / UI 结构**。没有一层覆盖「两玩家入座 → 准备 → 开局 → 交替落子 → 结算」。
而联机的失败模式（座位抢占、双端回合交接、对手掉线、房间解散）恰恰是 AI 模式测不出来的 —— 而这是你上线后的核心场景。

### M5. 测试体系里有相当比例是「源码字符串扫描」的弱断言
- `test-portrait-guards`、`validate-scenes` 的部分断言、第 12 层（副本一致性）：断言的是**文本存在**，把逻辑改坏（例如把判断取反、改调用点）仍可能全绿。
- 真正能证伪的是：`typecheck`、`test-core`、以及用内存库桩**真实调用云函数**的 `test-gomoku-ai-e2e` / `test-ai-fullgame` 等。
建议：新加的守护尽量走「真实调用 + 行为断言」，而不是 grep 源码。

### M6. 文档数字已漂移
- `README.md:69,70,189,338` 写「test-core **40 项**」，实际是 **52 项**
- `docs/SELF_TEST_CHECKLIST.md:152,275,293` 同样写 40 项
- `VERSION.md` 已更新为 52 项 → 三处口径不一致

---

## 三、低优先级
- `GomokuAuthority._reqSeq`（`GomokuGame.ts:34`）声明后从未使用（幂等实际靠 `_handled` Set）。
- `RoomScene._refs`（490 行）为「保持导入不被删」而存在的占位写法。
- 多份「同一事实多拷贝」风险仍在：云函数名 / 集合名 / AI 昵称池 / 棋盘尺寸在客户端与云函数各写一份（昵称池已有测试守护，其余部分没有）。

---

## 四、被证伪的子代理条目（记录以免日后误信）
以下条目**声称有代码证据，但我逐一核实为假**（多半是臆造了字段名/函数名）：
1. 「joinRoom 允许房主重复占位」→ **假**：`joinRoom/index.js:44-48` 有 `findSeatIndex` 幂等返回。
2. 「ready 不校验玩家属于房间」→ **假**：`ready/index.js:19-22` 有 `idx < 0 → throw UNAUTHORIZED('你不在该房间中')`。
3. 「客户端读 `room.players`，与服务端字段漂移」→ **假**：客户端读的是 `room.seats.find(s => s.playerId === openid)`（`WxRoomService.ts:265`），项目里**没有 `players` 字段**。
4. 「云函数返回 `{code:-1, msg}` 结构不统一」→ **假**：统一走 `fail(code, message)`（`common/index.js:99`）。
5. 「GomokuGame/PlaneHuntGame 的 `previewPlace`/`applyRemoteMove`/`RoomFacade`/`_myColor` 三段函数逐行对比」→ **假**：这些符号在仓库里**各 0 处**。
6. 「LobbyScene 缺 onDestroy 导致监听泄漏」→ **假**：LobbyScene 没有长驻监听/定时器，本就不需要。

教训：子代理的结论必须逐条复核后才能采信；本次 3 份报告里第 1 份的 5 条「确认问题」有 4 条是编造的。
