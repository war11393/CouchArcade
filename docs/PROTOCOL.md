# 消息协议设计（PROTOCOL）

> 适用于第一阶段（Mock 通道）与第二阶段（云函数 + 实时数据推送）。
>
> **核心设计**：Mock 与真实实现使用**完全相同的协议**，因此第一阶段即可验证协议与同步逻辑正确性，第二阶段切换时业务层零改动。

---

## 1. 协议信封

所有消息统一为以下结构（`assets/scripts/core/protocol/Protocol.ts`）：

```ts
interface ProtocolEnvelope<T> {
    cmd: string;        // 命令字，见第 3 节
    roomId: string;     // 房间号（6 位数字字符串）
    playerId: string;   // 消息发出者 openid（服务端下行时为权威判定者）
    payload: T;         // 命令负载（结构见第 4 节）
    timestamp: number;  // 毫秒时间戳（客户端本地时钟，仅用于排序/调试）
}
```

**校验**：所有下行消息必须先过 `isValidEnvelope()`，避免脏数据进入业务层。

```ts
function isValidEnvelope(msg: unknown): msg is ProtocolEnvelope {
    // 校验 cmd 为非空字符串、roomId/playerId 为字符串、timestamp 为数字
}
```

**构造**：统一用 `makeEnvelope(cmd, roomId, playerId, payload)` 保证字段齐全。

---

## 2. 通信模型

```
┌──────────┐  上行(云函数调用)   ┌─────────────┐   写库    ┌──────────┐
│ 客户端 A │ ─────────────────► │  云函数      │ ───────► │ 云数据库  │
│          │                    │ (权威裁判)   │          │          │
│          │ ◄───────────────── │             │ ◄─────── │  watch   │
└──────────┘  下行(实时推送)     └─────────────┘   推送    └──────────┘
                                     ▲
                                     │ 同样的协议通道
┌──────────┐                         │
│ Mock 权威 │ ────────────────────────┘
│ (本地AI)  │  第一阶段：MockNetSync 把 AI 决策封装成
└──────────┘  与真实服务器一致的下行消息回传
```

**关键原则**：

1. **上行只提交意图，不提交结果**
   - 正确：`{ cmd: 'gk.move', payload: { row, col, reqSeq } }`（我要下这里）
   - 错误：`{ cmd: 'gk.move', payload: { row, col, win: true } }`（我赢了 —— 可伪造）

2. **棋局变更只认下行权威消息**
   - 客户端 `send()` 后**不立即改本地棋盘**，等下行结果再更新
   - 这样客户端无法通过改内存作弊，与真实服务器模型一致

3. **幂等**
   - 上行带 `reqSeq`（客户端自增），服务端记录已处理序号，重复请求直接返回既有结果
   - 下行按「位置是否已有棋子/是否已翻开」判重，重连补发不会重复落子

4. **Mock 联机 = 通过同步协议通道与 AI 对打**
   - `MockNetSyncService` 持有 `IMockAuthority`（权威裁判）
   - 客户端 `send()` → 交给权威裁判 → 权威按规则算出结果 → 封装成下行 `NetMessage` 回传（带 80~200ms 模拟延迟）
   - 轮到 AI 时，权威裁判内部调用游戏 AI，把决策**也封装成一模一样的下行消息**
   - 因此业务层无法区分「真人」与「AI」—— 这正是第一阶段验证协议的目的

---

## 3. 命令字清单

### 3.1 房间级（`IRoomService`，通常走云函数）

| 命令 | 方向 | 说明 | 对应云函数 |
| :--- | :--- | :--- | :--- |
| `room.join` | 上行 | 加入房间 | `joinRoom` |
| `room.leave` | 上行/广播 | 离开房间 | `joinRoom(action:leave)` |
| `room.ready` | 上行 | 准备/取消准备 | `ready` |
| `room.start` | 下行广播 | 房主开局广播 | `startGame` |
| `room.state` | 下行 | 房间状态快照 | `getRoomState` / watch |
| `room.dissolve` | 下行广播 | 房间解散（超时/主动） | `getRoomState` 惰性判定 |

### 3.2 对局会话级（`INetSyncService`）

| 命令 | 方向 | 说明 |
| :--- | :--- | :--- |
| `game.start` | 下行 | 对局开始，携带先手方与随机种子 |
| `game.turn` | 下行 | 回合切换（含剩余时间、回合序号） |
| `game.over` | 下行 | 对局结束（胜负、原因、统计） |
| `game.surrender` | 上行 | 投降 |
| `game.emote` | 双向 | 表情快捷互动 |
| `game.ping` | 上行 | 心跳 |
| `game.offline` / `game.reconnect` | 双向 | 断线/重连 |
| `game.resync` | 上行 | 请求全量状态（重连补偿） |

### 3.3 寻机头（`planehunt_*`）

| 命令 | 方向 | 说明 |
| :--- | :--- | :--- |
| `ph.flip` | 上行 | 请求翻格 `{ row, col, reqSeq }` |
| `ph.flip.result` | 下行 | 翻格权威结果 |
| `ph.layout` | 下行 | 布局元信息（**仅尺寸/飞机数，不含明文机头**） |

### 3.4 五子棋（`gomoku_*`）

| 命令 | 方向 | 说明 |
| :--- | :--- | :--- |
| `gk.move` | 上行 | 请求落子 `{ row, col, reqSeq }` |
| `gk.move.result` | 下行 | 落子权威结果（含五连判定与连线） |

### 3.5 系统

| 命令 | 方向 | 说明 |
| :--- | :--- | :--- |
| `sys.error` | 下行 | 通用错误（code + message + 原始 cmd） |

---

## 4. 关键 payload 结构

### 4.1 `game.start` — 对局开始

```ts
{
    gameId: 'planehunt' | 'gomoku',
    firstPlayerId: string,   // 先手（黑）玩家 openid
    seed: number,            // 随机种子（服务端生成，双端一致）
    serverTime: number       // 服务端时间戳，用于校准客户端计时器
}
```

### 4.2 `ph.flip.result` — 寻机头翻格结果（服务端权威）

```ts
{
    row: number,
    col: number,
    cell: 0 | 1 | 2,         // 0=空 1=机身 2=机头（服务端返回真实内容）
    scored: boolean,         // 是否翻中机头得分
    extraTurn: boolean,      // 是否获得奖励连翻
    headsFound: number,      // 当前累计已翻出机头数
    score: number,           // 该玩家累计得分
    nextPlayerId: string,    // 下一步该谁行动
    planeIndex: number       // 所属飞机编号（-1 表示非飞机），用于 UI 高亮
}
```

> ⚠️ **安全核心**：客户端永远拿不到完整布局，只能逐格询问结果。
> 因此即使玩家反编译前端也无法获知机头位置。

### 4.3 `gk.move.result` — 五子棋落子结果（服务端权威）

```ts
{
    row: number,
    col: number,
    stone: 1 | 2,            // 1=黑 2=白
    playerId: string,        // 落子方
    win: boolean,            // 是否获胜
    winLine: Array<{row, col}>,  // 获胜连线（用于高亮），未获胜为空数组
    draw: boolean,           // 是否和棋
    nextPlayerId: string     // 下一步该谁行动
}
```

### 4.4 `game.over` — 对局结束

```ts
{
    winnerId: string,        // 胜者 openid；平局为空字符串
    draw: boolean,
    reason: 'win' | 'draw' | 'surrender' | 'timeout' | 'offline' | 'leave',
    stats: Array<{ playerId: string, score: number, moves: number }>
}
```

### 4.5 `game.emote` — 表情

```ts
{ emoteId: number }   // 索引 EMOTES 数组（👍😄😭😡🤔🎉😴🙈）
```

---

## 5. 错误码约定

服务端通过 `sys.error` 或返回体 `code` 字段告知客户端：

| code | 含义 | 客户端建议处理 |
| :--- | :--- | :--- |
| `0` | 成功 | — |
| `4001` | 房间不存在 | Toast 提示并回大厅 |
| `4002` | 房间已满 | Toast 提示并回大厅 |
| `4003` | 房间已开局 | Toast 提示并回大厅 |
| `4004` | 房间已解散 | 回大厅 |
| `4005` | 非房主操作 | 禁用「开始游戏」按钮 |
| `4006` | 未全员准备 | 提示「等待全员准备」 |
| `4007` | 非法操作（越界/占位/翻转已翻开格） | 静默忽略（可能因网络重发） |
| `4008` | 未轮到你 | 静默忽略 + 刷新回合指示 |
| `4009` | 未授权（不在房间） | 回大厅并重新登录 |
| `5000` | 服务端内部错误 | Toast 提示并提供重试 |

> 定义位置：`cloudfunctions/common/index.js` 的 `ERR` 常量。

---

## 6. 时序图

### 6.1 建房 → 开局 → 对局（联机）

```
A(客户端)         云函数/数据库              B(客户端)
   │                    │                      │
   ├─ createRoom ──────►│                      │
   │◄── RoomState ──────┤ (rooms 插入)          │
   │                    │◄───── joinRoom ───────┤
   │◄─ watch 推送 ──────┤ (seats 更新) ────────►│
   │                    │◄───── ready ──────────┤
   ├─ ready ───────────►│                      │
   │◄─ watch: status=ready ────────────────────►│
   ├─ startGame ───────►│ (生成 seed + 权威布局) │
   │◄─ watch: status=playing ──────────────────►│
   │                    │                      │
   │  ┌── 双方进入 Game 场景，各自 watch 对局集合 ──┐
   │                    │                      │
   ├─ gk.move(7,7) ────►│ 校验+落子+五连检测     │
   │◄─ watch: 新棋步 ───┤──────────────────────►│ (B 看到 A 的棋子)
   │                    │◄──── gk.move(8,8) ────┤
   │◄─ watch: 新棋步 ───┤──────────────────────►│
   │        ...         │        ...           │
   │◄─ watch: finished ─┤ 判定胜负 ────────────►│
   │                    │                      │
   ├─ settleGame ──────►│ 写 match_records      │
   │◄── 结算结果 ───────┤──────────────────────►│
```

### 6.2 断线重连（关键路径）

```
A(客户端)                           云函数/数据库
   │                                     │
   │  ✗ 网络中断 5 秒（watch 断开）        │
   │                                     │
   │  wx.onShow / onNetworkStatusChange  │
   ├─ reconnect() ──────────────────────►│
   │  ① 重建 watch                        │
   │  ② getRoomState（全量对账）◄─────────┤
   │  ③ 与本地棋局 diff，补齐丢失棋步      │
   │                                     │
   │  ✓ 棋局与对手完全一致                 │
```

> ⚠️ **仅重建 watch 不够**：watch 重连只推增量，离线期间的棋步会永久丢失。
> 必须调 `getRoomState` 拉全量状态并做 diff 补偿。

### 6.3 Mock 通道下的 AI 对局（第一阶段）

```
PlaneHuntGame          MockNetSyncService         PlaneHuntAuthority
    │                        │                          │
    ├─ send('ph.flip') ─────►│                          │
    │                  延迟80~200ms                     │
    │                        ├─ handleUpstream() ─────►│
    │                        │                   按规则判定+计分
    │                        │◄── 下行消息数组 ─────────┤
    │◄── onMessage(下行) ────┤                          │
    │  更新棋盘/UI            │                          │
    │                        │                          │
    │                  轮询(每200ms)                     │
    │                        ├─ pollAiAction() ───────►│
    │                        │              AI 决策(0.5~1.5s思考)
    │                        │◄── AI 的落子消息 ────────┤
    │◄── onMessage(下行) ────┤                          │
    │  渲染对手操作（与真人无差别）                        │
```

---

## 7. 新增游戏的协议扩展规范

添加一款新游戏（如「斗地主」）时：

1. 在 `Protocol.ts` 的 `Cmd` 枚举中追加命令字，前缀用游戏缩写（如 `ddz.`）：
   ```ts
   DDZ_PLAY = 'ddz.play',
   DDZ_PLAY_RESULT = 'ddz.play.result',
   ```
2. 为新命令定义强类型 payload 接口
3. 在 `cloudfunctions/` 下新增对应云函数（如 `ddz_play`），并在 `common/index.js` 的集合常量中加 `GAMES_DDZ`
4. 服务端**必须**做权威校验（不能信任客户端上报的出牌）
5. 更新本文件的第 3、4 节

> 复用既有命令：`game.start` / `game.turn` / `game.over` / `game.surrender` / `game.emote`
> 是**游戏无关**的，新游戏直接复用即可。
