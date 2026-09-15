# 云数据库集合设计（CLOUD DESIGN）

> ⚠️ **第二阶段部署**：本文件描述的设计在第一阶段**不部署**，仅作为交付物。
> 第一阶段 Mock 实现用内存 `Map` 模拟同样的结构（见 `MockCloudService`）。

---

## 1. 集合总览

| 集合 | 用途 | 文档量级 | 生命周期 |
| :--- | :--- | :--- | :--- |
| `users` | 用户资料与战绩统计 | 用户数 | 永久 |
| `rooms` | 房间状态（座位、准备、状态机） | 活跃房间数 | 局后保留（可定期归档） |
| `games_planehunt` | 寻机头对局（**含权威布局**） | 局数 | 局后归档 |
| `games_gomoku` | 五子棋对局（落子序列） | 局数 | 局后归档 |
| `match_records` | 战绩流水 | 局数 × 玩家数 | 永久（可按用户查询） |

---

## 2. 集合详细设计

### 2.1 `users` — 用户表

```jsonc
{
  "_id": "自动生成",
  "openid": "oXXXXXXXXXXXXXXXXXXX",   // 主键，来自 cloud.getWXContext().OPENID
  "unionid": "",                       // 同一开放平台下多应用互通时使用
  "nickname": "测试玩家",
  "avatarUrl": "",                     // 第二阶段建议改存 cloud:// fileID（临时 URL 会过期）
  "winCount": 0,
  "loseCount": 0,
  "drawCount": 0,
  "createdAt": 1757000000000,
  "lastLoginAt": 1757000000000,
  "lastPlayedAt": 1757000000000
}
```

**索引**：
- `openid`（唯一索引）— 登录与统计查询的主键

**权限**：仅创建者可读写（云函数以管理员权限运行，不受此限制）

**写入时机**：
- `login` 云函数：upsert（不存在则创建，存在则更新 `lastLoginAt` 与昵称头像）
- `settleGame` 云函数：累加 `winCount` / `loseCount` / `drawCount`

---

### 2.2 `rooms` — 房间表

```jsonc
{
  "_id": "自动生成",
  "roomId": "483920",                 // 6 位数字，唯一
  "gameId": "gomoku",                 // 'planehunt' | 'gomoku'
  "status": "waiting",                // waiting | ready | playing | finished | dissolved
  "seats": [
    {
      "seatIndex": 0,
      "playerId": "oXXX",             // 空字符串表示空位
      "nickname": "房主玩家",
      "avatarUrl": "",
      "ready": false,
      "online": true,
      "isOwner": true,
      "isAI": false,                  // true = AI 托管（断线托管/AI 练习）
      "aiLevel": 2,                   // 1=简单 2=普通 3=困难
      "score": 0                      // 寻机头用；每局开始重置
    },
    {
      "seatIndex": 1,
      "playerId": "",
      "nickname": "",
      "avatarUrl": "",
      "ready": false,
      "online": false,
      "isOwner": false,
      "isAI": false,
      "aiLevel": 2,
      "score": 0
    }
  ],
  "ownerId": "oXXX",                  // 房主 openid（房主退出时服务端移交）
  "maxPlayers": 2,
  "isPractice": false,                // AI 练习房（建议纯客户端本地，不走云函数）
  "seed": 123456789,                  // 对局随机种子（startGame 时生成）
  "currentTurnPlayerId": "oXXX",
  "createdAt": 1757000000000,
  "updatedAt": 1757000000000,
  "startedAt": 0,
  "finishedAt": 0,
  "dissolvedAt": 0,
  "winnerId": "",
  "draw": false
}
```

**索引**：
- `roomId`（唯一索引）— 入房与 watch 查询
- `status` + `updatedAt`（复合索引）— 定期清理僵尸房间

**权限**：**所有用户可读，仅管理端可写**

> ⚠️ 必须可读 —— 客户端 `watchRoom()` 依赖实时推送房间状态。
> 写操作只允许通过云函数（服务端权威），防止客户端篡改座位/状态。

**状态机**：

```
         创建
          │
          ▼
     ┌─────────┐  全员入座+全员准备   ┌────────┐
     │ WAITING │ ──────────────────► │ READY  │
     └─────────┘ ◄────────────────── └────────┘
          │        有人取消准备           │
          │                             │ 房主 startGame
          │                             ▼
          │                        ┌──────────┐
          │                        │ PLAYING  │
          │                        └──────────┘
          │                             │ settleGame
          │                             ▼
          │                        ┌──────────┐
          │     超时/房主退出无人    │ FINISHED │
          └───────────────────────►├──────────┤
                                   │DISSOLVED │
                                   └──────────┘
```

**并发保护**（关键）：
入座用「更新条件带 `seats.<i>.playerId: ''`」的乐观锁：
```js
await db.collection('rooms')
    .where({ roomId, status: 'waiting', ['seats.' + i + '.playerId']: '' })
    .update({ data: { seats } });
// stats.updated === 0 表示竞争失败 → 重试或返回房间已满
```

---

### 2.3 `games_planehunt` — 寻机头对局表

```jsonc
{
  "_id": "自动生成",
  "roomId": "483920",
  "gameId": "planehunt",
  "seed": 123456789,
  "size": 12,
  "planeCount": 5,

  // ⚠️⚠️ 权威布局：绝不下发客户端 ⚠️⚠️
  "heads": [                          // 机头坐标（服务端私有）
    { "row": 2, "col": 3, "planeIndex": 0 },
    { "row": 5, "col": 8, "planeIndex": 1 }
  ],
  "cells": [[0,0,2,...], ...],        // 完整布局矩阵（服务端私有）
  "fingerprint": "a3f9c21b",          // 布局指纹（双端一致性校验）

  "revealed": {                       // 已翻开的格子，key = "row,col"
    "2,3": { "cell": 2, "byPlayerId": "oXXX", "planeIndex": 0, "at": 1757000000000 }
  },
  "headsFound": 1,
  "scores": { "oXXX": 1, "oYYY": 0 },
  "moves": { "oXXX": 3, "oYYY": 2 },
  "currentPlayerId": "oYYY",
  "finished": false,
  "winnerId": "",
  "draw": false,
  "createdAt": 1757000000000,
  "updatedAt": 1757000000000
}
```

**索引**：`roomId`（唯一索引）

**权限**：**所有用户可读，仅管理端可写**

> ⚠️ 安全说明：
> 1. 客户端**只能**通过 `planehunt_flip` 云函数逐格查询结果，**不能**直接读 `heads` / `cells`；
> 2. 若权限设为「所有用户可读」，客户端在技术上能读到这些字段 —— **这是当前设计的已知风险**。
>    更严格的做法是把 `heads`/`cells` 拆到**另一个集合**（如 `games_planehunt_secret`），
>    权限设为「仅管理端可读写」，客户端只 watch 非敏感字段所在的集合。
>    **第二阶段部署时建议采用拆分方案**，或改用云托管 WebSocket 完全不下发对局文档。
> 3. 布局生成算法与客户端 `PlaneHuntLayout.ts` 同构（mulberry32 + 旋转 + 碰撞重试），
>    保证同一 seed 推导结果一致。

---

### 2.4 `games_gomoku` — 五子棋对局表

```jsonc
{
  "_id": "自动生成",
  "roomId": "483920",
  "gameId": "gomoku",
  "seed": 123456789,
  "size": 15,
  "winCount": 5,
  "board": [[0,0,1,...], ...],        // 15×15，0=空 1=黑 2=白
  "history": [                        // 落子序列（重连补偿用）
    { "row": 7, "col": 7, "playerId": "oXXX", "stone": 1, "at": 1757000000000 },
    { "row": 8, "col": 8, "playerId": "oYYY", "stone": 2, "at": 1757000000001 }
  ],
  "moveCount": 2,
  "currentPlayerId": "oXXX",
  "finished": false,
  "winnerId": "",
  "draw": false,
  "winLine": [],                      // 获胜连线，用于高亮
  "createdAt": 1757000000000,
  "updatedAt": 1757000000000
}
```

**索引**：`roomId`（唯一索引）

**权限**：所有用户可读，仅管理端可写

> 五子棋的 `board` 是「双方共同可见」的公开信息，因此可读无风险（与寻机头不同）。

---

### 2.5 `match_records` — 战绩流水表

```jsonc
{
  "_id": "自动生成",
  "openid": "oXXX",                   // 该条记录归属的玩家
  "nickname": "测试玩家",
  "gameId": "gomoku",
  "roomId": "483920",
  "result": "win",                    // 'win' | 'lose' | 'draw'
  "score": 0,                         // 寻机头得分；五子棋为 0
  "moves": 12,                        // 本局步数
  "opponentId": "oYYY",
  "durationMs": 95400,
  "judgmentSource": "server_authoritative",  // 结果来源：服务端判定 or 客户端上报
  "createdAt": 1757000000000
}
```

**索引**：
- `openid` + `createdAt`（复合索引，倒序）— 查询「我的最近战绩」

**权限**：仅创建者可读写

**设计要点**：
- **一局产生两条记录**（每个玩家一条），便于「我的战绩」直接按 `openid` 查询，无需 OR
- `judgmentSource` 记录结果来源：`server_authoritative`（服务端从棋局推导，可信）或 `client_reported`（投降等场景，可信度较低）
- 写入由 `settleGame` 云函数完成（管理员权限，可写他人记录）

---

## 3. 云函数清单

| 云函数 | 触发 | 职责 | 关键校验 |
| :--- | :--- | :--- | :--- |
| `login` | 客户端调用 | upsert 用户，返回 openid | openid 来自 `getWXContext()`，不可伪造 |
| `createRoom` | 客户端调用 | 分配唯一房间号，创建者坐 0 号位 | 游戏类型合法；房间号去重重试 |
| `joinRoom` | 客户端调用 | 占座 / 退房 / 房主移交 | **乐观锁防并发抢座**；已开局拒绝加入 |
| `ready` | 客户端调用 | 更新准备状态，全员准备则置 `ready` | 必须在房间内；对局中拒绝 |
| `startGame` | 客户端调用 | 生成 seed 与**权威布局**，置 `playing` | 必须是房主；必须全员准备 |
| `getRoomState` | 客户端调用 | 拉全量状态（断线重连兜底） | 惰性判定超时解散 |
| `planehunt_flip` | 客户端调用 | 翻格，返回真实格子内容 | **轮次校验 + 幂等 + 越界校验** |
| `gomoku_move` | 客户端调用 | 落子 + 四方向五连检测 | **轮次 + 占位 + 越界校验** |
| `settleGame` | 客户端调用 | 写战绩 + 更新用户统计 + 置 `finished` | 优先用服务端棋局判定，防止刷分 |

**公共模块**（`cloudfunctions/common/index.js`）：
- `init()` — 云初始化 + 返回 `db` / `openid`
- `wrap(name, handler)` — 统一 try/catch、错误码转换、日志
- `BizError` — 业务异常（自动转成 `fail` 响应）
- `requireRoom()` / `findSeatIndex()` / `updateRoom()` — 房间工具
- `genRoomId()` / `genSeed()` / `makeRng()` — 房间号与确定性随机（与客户端同算法）
- `COLLECTIONS` / `ROOM_STATUS` / `ERR` — 共享常量

> ⚠️ 微信云函数**不能 require 上级目录**，因此 `common.js` 会被复制到每个云函数目录。
> 修改后需运行 `node tools/gen-cloudfunctions.js` 重新同步（本项目已提供该脚本）。

---

## 4. 数据生命周期与清理

| 数据 | 保留策略 | 清理方式 |
| :--- | :--- | :--- |
| `rooms`（已结束/解散） | 保留 7 天 | 定时触发器云函数 `cleanup`（第二阶段可加）批量删除 `updatedAt < now - 7d` |
| `games_planehunt` | 保留 7 天 | 同上（**含权威布局，应尽快清理以降风险**） |
| `games_gomoku` | 保留 7 天 | 同上 |
| `match_records` | 永久 | 按用户分页查询，量大时可归档到冷存储 |
| `users` | 永久 | — |

**惰性清理**：`getRoomState` 中已实现「房间创建超过 30 分钟且未开局 → 标记 `dissolved`」，
避免依赖额外的定时触发器即可回收僵尸房间。

---

## 5. 与客户端常量的对应关系

服务端集合名必须与客户端 `assets/scripts/config/Collections.ts` **完全一致**：

| 客户端常量 | 值 | 服务端常量 |
| :--- | :--- | :--- |
| `COLLECTIONS.USERS` | `users` | `COLLECTIONS.USERS` |
| `COLLECTIONS.ROOMS` | `rooms` | `COLLECTIONS.ROOMS` |
| `COLLECTIONS.GAMES_PLANEHUNT` | `games_planehunt` | `COLLECTIONS.GAMES_PLANEHUNT` |
| `COLLECTIONS.GAMES_GOMOKU` | `games_gomoku` | `COLLECTIONS.GAMES_GOMOKU` |
| `COLLECTIONS.MATCH_RECORDS` | `match_records` | `COLLECTIONS.MATCH_RECORDS` |
| `CLOUD_FUNCTIONS.LOGIN` | `login` | 目录名 `login` |
| `CLOUD_FUNCTIONS.CREATE_ROOM` | `createRoom` | 目录名 `createRoom` |
| ... | ... | ... |

> 修改任一侧时，务必同步另一侧（这是最容易出错的地方）。
