# screepsmod-exec-cli-in-console

[English](./README.md) | [中文](./README.zh.md)

让玩家可以在**游戏内控制台**执行（部分）Screeps 私服的**仅 CLI 可用**命令。

该 mod 会把 `Game.cli.exec(code)` 注入到玩家沙箱中：玩家在控制台调用后，服务端会异步排队执行对应的 CLI JS，并把输出流式回写到玩家控制台。

## 功能

- 在游戏内控制台执行服务端 CLI JS：`Game.cli.exec('help()')`
- 内置便捷函数：
  - `Game.cli.help()`
  - `Game.cli.setStore(target, store)`
  - `Game.cli.setStoreHuge(target)`
  - `Game.cli.setControllerLevel(target, level)`
  - `Game.cli.finishConstructionSites(rooms)`
- **默认安全**（重要）：
  - **默认拒绝**（必须显式放行用户）
  - 两级权限：**普通用户** / **超管**
  - 可选 `allowedCodePrefixes` 前缀白名单
  - 输出行数与执行时间限制

## 安装

按常规 Screeps 私服 mod 的方式安装即可：

1. 将本包放到私服的 `mods/` 目录下（或在私服目录内用 npm/pnpm/yarn 安装）。
2. 在 `mods.json` 中启用该 mod。

`mods.json` 示例：

```json
{
  "mods": [
    "screepsmod-auth",
    "screepsmod-admin-utils",
    "screepsmod-exec-cli-in-console"
  ]
}
```

## 配置（非常重要）

请直接编辑 `execute-cli.js` 顶部的 `SETTINGS`：

- `allowAllUsers`：若为 `true`，所有真实玩家都会被视为**普通用户**（不是超管）。除非本地/单机测试服，否则不要开。
- `normalUserIds` / `normalUsernames`：当 `allowAllUsers=false` 时，普通用户白名单。
- `superAdminUserIds` / `superAdminUsernames`：超管白名单。
- `superAdminUsersCodeSelfOnly`：若为 `true`，即便是超管也不允许读/改其他用户在 `users.code` 里的代码（隐私保护）。
- `allowedCodePrefixes`：如果不为空，只允许执行以这些前缀开头的代码字符串。
- 限制项：
  - `maxCodeLength`
  - `maxOutputLines`
  - `evalTimeoutMs`
  - `promiseTimeoutMs`

## 用法（游戏内控制台）

### 快速开始

```js
Game.cli.help()
Game.cli.exec('help()')
```

### 执行 CLI helper

```js
Game.cli.exec('system.getTickDuration()')
```

### 修改 `rooms.objects.store`

`target` 支持：`_id`、`id`，或带有 `_id/id` 字段的对象。

```js
Game.cli.setStore('679f...67f3', { energy: 1000 })
Game.cli.setStoreHuge('679f...67f3')
```

### 设置房间控制器等级

```js
Game.cli.setControllerLevel('67c8...df8', 8)
```

### “秒建”房间内建筑工地（接近完成）

把指定房间内所有工地设置为：`progress = progressTotal - 1`

```js
Game.cli.finishConstructionSites(['W1N9'])
```

## 安全说明

执行服务端 CLI JS 权限很大：

- CLI 沙箱可访问服务端内部对象，例如 `storage.*`、`system.*`。
- 本 mod **默认拒绝**。不建议在公开服务器对所有玩家开放，除非你非常清楚风险并做好额外限制。

权限差异：

- **普通用户**：会被限制 CLI 沙箱能力：
  - `storage` 会被替换成受限包装（主要限制到自己名下的房间/对象）
  - `system/map/bots/strongholds` 会被移除
- **超管**：可使用完整 CLI 沙箱（可选开启 `users.code` 仅自身可读写的隐私保护）

## 常见问题

- **`Game.cli` 不存在**：
  - 确认已在 `mods.json` 启用并重启私服。
  - 确认环境可用 `isolated-vm`（Screeps 玩家沙箱依赖它）。
- **提示 `[cli] denied: not allowed user`**：
  - 把你的 userId / 用户名加入 `SETTINGS.normalUserIds/normalUsernames` 或 `superAdmin*`。
- **输出缺失/被截断**：
  - 调整 `maxOutputLines`、`evalTimeoutMs`、`promiseTimeoutMs`。

## License

MIT