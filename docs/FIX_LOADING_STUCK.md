# 卡加载页 / 登录失败 — 修复报告

**日期**：2026-09-22
**Cocos Creator**：3.8.8
**微信开发者工具基础库**：3.17.2（Windows，lib 3.17.2 / mg 2.02.2608070）

---

## 症状

冷启动后**永远停在 Loading 场景**，进度条不再前进，进不了大厅。
控制台关键输出：

```
[ServiceLocator] ensureServices：运行时兜底注入（AppBootstrap 未执行）
[ServiceLocator] 注入 Wx 实现（真机模式）
[WxCloudService] 云环境初始化完成 env=cloud1-d7gp1em2efcf2b05b
[LoadingScene] 帧率设置为 60
[WxAuth] login 云函数失败（code=9003 服务器返回异常），尝试使用本地缓存兜底
  CloudError: [WxAuth] login 返回缺少 openid
[LoadingScene] 启动失败: CloudError: [WxAuth] login 返回缺少 openid
```

> 另有 `[jsbridge] invoke getSystemInfo fail: jsbridge not ready` —— **与本次故障无关**。
> 该报错来自微信开发者工具自身在 jsbridge 就绪前抢跑一次 `getSystemInfo`，
> 出现在 `deviceOrientation` 的 getter 里（见堆栈 `at get deviceOrientation`），
> 小游戏侧无代码可改。基础库初始化完成后自动消失。

---

## 根因（已确证）

云函数日志拿到了，**根因是云函数信封被「双重包装」**。

云函数实际返回（真机日志原文）：

```json
{"code":0,"success":true,"data":{"code":0,"success":true,"data":{
  "openid":"oniFY3bWh7mTmF9-E2g9C5ai4oTU","nickname":"微信用户",...}}}
```

注意 `data` 里**又是一个完整的信封**，真正的业务数据被埋在内层。
于是客户端 `WxCloudService.callFunction()` 解包拿到的
`data` = 内层信封对象（没有 `openid` 字段）→ `WxAuthService` 判空
→ 抛「login 返回缺少 openid」→ 加载页卡死。

**这个错误信息是误导性的**：云函数其实执行成功了（日志里
`[login] → 成功 耗时=244ms` 明明白白），openid 也确实返回了 ——
只是被多包了一层，客户端在错误的位置找 openid。

### 机制：`ok()` 没打「已包装」标记，被 `wrap()` 又包了一次

`cloudfunctions/common/index.js`：

```js
// wrap() 内部（第 111 行）
const resp = result && result.__isResponse ? result : ok(result);
//                     ^^^^^^^^^^^^^^^ 判定依据

// 但 ok() 当初并没有设置这个标记
function ok(data, extra) {
    return Object.assign({ code: ERR.OK, success: true, data: ... }, extra || {});
}   //                            ^ 没有 __isResponse
```

`return ok(x)` 的返回值**不带** `__isResponse` → `wrap()` 认为「handler 返回的是
裸业务数据」，于是**再包一次** `ok(...)` → 双重包装。

这不是偶发，是**必然**：`__isResponse` 在整个 `cloudfunctions/` 里
只用不设（`grep -rn "__isResponse"` 修复前只在 9 个 `common.js`
的 `wrap()` 那一行出现，无任何地方写入该字段）。

**影响面：全部 9 个云函数**（`login`、`createRoom`、`joinRoom`、`ready`、
`startGame`、`getRoomState`、`planehunt_flip`、`gomoku_move`、`settleGame`），
共 16 处 `return ok(...)` —— 每一个都在被双重包装。这不只是登录问题，
**整套云函数通信都是坏的**，只是登录最先暴露。

---

## 次要问题：加载页把「登录失败」当成「启动失败」，然后原地卡死

`LoadingScene._boot()` 的 catch 分支只做两件事：

```ts
this._setProgress(this._progress, `启动失败：${(err as Error).message}`);
setLabelText(this.node, 'Canvas/Hint', '点击重试');
this._bindRetry();
```

进度停住、状态文案写死，**没有跳转**。于是：
「云函数 login 挂了」→「登录抛错」→「整个小游戏打不开」。

这个耦合本身就是 bug：**登录失败不该等于游戏打不开**。
单人模式（AI 练习）完全不依赖服务端，本地缓存功能也都在，
它们没有任何理由被云端故障连坐。

而 `WxAuthService.login()` 的兜底只有一级：

```ts
if (cached && cached.openid) { return cached; }   // 只有缓存
throw err;                                        // 缓存没有 → 抛给上层
```

冷启动（清缓存 / 首次安装）时缓存为空 → 必抛 → 必卡。

### 附：`code=9003` 是客户端包装码，不要被它误导

`9003` 来自 `CloudErrors.ts`，语义是「云函数调用返回了不可用结果」，
**不是微信服务端的错误码**。本轮就是被它带偏了一轮排查方向
（一度以为云函数没部署）。以后见到它，直接去看云函数原始返回体。

另外云开发控制台有**两个「日志」入口**，极易混淆：

- 云开发控制台**顶部**的「日志」= 云环境总日志，只记数据库/存储操作，
  **不记云函数调用** —— 在这里翻不到 `login` 的调用记录是正常的；
- 要看云函数日志，必须 **云函数 → 函数列表 → 点进 `login` → 「日志」标签页**。

本轮「云函数没有调用记录」的误判就源于此。

---

## 修复

### ① 【本次核心】`ok()` / `fail()` 补上 `__isResponse` 标记

`cloudfunctions/common/index.js`：

```js
function ok(data, extra) {
    return Object.assign(
        { code: ERR.OK, success: true, data: data === undefined ? null : data, __isResponse: true },
        extra || {},
    );
}

function fail(code, message) {
    return { code, success: false, message: message || '操作失败', __isResponse: true };
}
```

这样 `wrap()` 的判定 `result.__isResponse ? result : ok(result)` 才生效，
`return ok(x)` 不再被二次包装。

**必须同步 9 份副本**：微信云函数不支持跨目录 `require`，`common.js`
被复制进每个云函数目录。改完权威源后要逐个同步：

```bash
for d in cloudfunctions/*/; do n=$(basename "$d"); [ "$n" = "common" ] && continue; \
  cp cloudfunctions/common/index.js "$d/common.js"; done
```

改完用 `npm` 无关的纯 Node 脚本自检（见下）：9 份 md5 必须一致。

### ② 【纵深防御】客户端识别双重包装并点明根因

`WxCloudService.callFunction()` 增加形状自检：若 `envelope.data`
本身又是一个 `{code, success}` 信封，直接抛明确错误：

```
返回体被**双重包装**：外层信封的 data 里又是一个信封。
根因是云函数 common.js 的 ok()/fail() 缺少 `__isResponse` 标记，被 wrap() 二次包装。
```

**为什么值得加**：这个 bug 的表象（「login 返回缺少 openid」）与真因
（信封多包一层）毫无关联，本轮为此绕了一大圈。让错误信息直接说出根因，
下次同类问题一眼可见。

### ③ `WxAuthService.login()` 改为三级兜底，**永不抛错**

```
① 云端 openid 缓存命中        → 直接用（网络抖动不影响开局）
② 上一轮已降级的本地会话      → 直接复用，不再等一次必失败的云调用
③ 都没有                      → 造本地会话（openid = "local_" + 8 位哈希）
```

本地会话 id 用 `wx.login()` 的 `code` 经 FNV-1a 32 位哈希派生：

- `code` 是小游戏端唯一稳定可得的设备身份凭据，同一设备冷启动拿到同一份身份
  → 本地 id 在设备内稳定，不会每次启动都「换个人」，按 openid 归集的
  本地缓存 / 房间列表逻辑照常工作；
- 取不到 code 时退化为 `Date.now()_Math.random()` 随机 id ——
  宁可换身份，也不要卡在加载页；
- 带 `local_` 前缀，日志与题库里一眼可辨「这不是云端下发的真 openid」。

⚠️ 本地 id **不是可信身份**，不能用于联机对局（服务端 `getWXContext().OPENID`
校验必然不通过），只用于让单机流程跑起来。每次降级打 `warn` 日志，
并在其中写明「联机功能不可用，请修复云函数」。

### ④ `LoadingScene` 失败改为**降级放行进大厅**

catch 分支不再原地停留，改调 `_degradeToLobby(err)`：
写状态文案 + Toast 提示 + `scheduleOnce(0.8s)` 后 `uiManager.gotoLobby()`。

为什么不留在加载页重试：加载页的重试按钮是「同一个必失败的动作再来一次」，
用户点几次就放弃了。进大厅后单机与本地功能都可用 ——
**这才是失败的合理下限**。

原 `_bindRetry()` 保留（兜住「连降级本身都失败」的残余可能性，且重试幂等），
但已不是登录失败的主路径。

### ⑤ `UIManager._load()` 加幂等保护

`_degradeToLobby` 的 `gotoLobby()` 与冷启动直达可能都跑到同一个目标场景，
第二次 `director.loadScene()` 会把刚建好的大厅整个拆掉重建 ——
表现为「大厅闪一下又回到加载画面」。现在已在目标场景则跳过：

```ts
if (cur && cur.name === scene) { return; }
```

顺带删掉了 `if (scene === LOADING) {...} else {...}` 这个两支完全相同的死分支。

### ⑥ `_preload()` 从「延时凑进度」改为真实预加载

原先 `_preload()` 是 `8 × await this._delay(45)`，进度条在演、没做任何事。
两个资源包（`internal`、`main`）是分包，**第一次用到才下载**，
而「第一次用到」的地方正是 Lobby → 用户会看到大厅 UI 一部分先出现、
一部分后出现。现在在加载页 `bundle.preload([])` 提前拉完，大厅首帧即完整。

超时 4s，失败只打 warn 不阻断 —— **优化手段绝不能变成新的卡死点**。
（注意 `AssetBundle.preload` 是回调式 API，不是 Promise，已手工包一层。）

---

## 验证状态

| 项 | 状态 |
| :--- | :--- |
| `cmd /c typecheck.cmd` | ✅ `TYPECHECK_EXIT=0` |
| `node tools/test-core.js` | ✅ 52 通过 / 0 失败 |
| `node tools/test-auth-fallback.js` | ✅ 18 通过 / 0 失败（故障注入时确实变红，证明有效） |
| `node tools/test-cloud-envelope.js` | ✅ 18 通过 / 0 失败（含「未打标记必然双包」反例） |
| `node tools/validate-scenes.js` | ✅ `ALL_SCENE_VALIDATIONS_PASSED` |
| 9 份 `common.js` md5 一致 | ✅ 已同步 |
| 微信开发者工具真机启动 | ⏳ **未验证 —— 需重新部署云函数 + 重新构建** |

**必须做的两步（我无法代做）**：

1. **重新部署云函数**：微信开发者工具 → 右键 `cloudfunctions/login` →
   上传并部署（云端安装依赖）。**注意**：`common.js` 改了，所以
   **9 个云函数都要重新部署**，否则其余 8 个仍是双重包装。
2. **重新构建**：Cocos Creator → 项目 → 构建发布 → 微信小游戏 → 构建。
   （`build/wechatgame/` 的产物不会自动跟随源码，必须显式构建。）

**未验证部分说明**：双重包装的修复在**单元层面已证明**（`test-cloud-envelope.js`
用真源码 + 复刻 `wrap()` 判定逻辑跑通，并含反例），但**真机端到端没有跑过** ——
需要先完成上述两步。降级路径的 Toast 可见性、0.8s 延时是否够、
大厅首帧是否完整，同样未在真机验证。
