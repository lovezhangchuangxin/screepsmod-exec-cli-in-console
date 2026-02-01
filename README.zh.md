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

在私服根目录（与 `mods.json` 同级）创建 `execute-cli.config.json` 配置文件。只需填写你想覆盖的字段，未填写的字段使用默认值。

`execute-cli.config.json` 示例：

```json
{
  "allowAllUsers": false,
  "normalUsernames": ["player1", "player2"],
  "superAdminUsernames": ["admin"],
  "superAdminUserIds": ["1"]
}
```

配置文件搜索顺序：
1. `MODFILE` 环境变量指定的目录（Screeps 私服会将其设为 `mods.json` 路径）
2. 当前工作目录（`process.cwd()`）
3. mod 目录的上一级
4. 上两/三级目录（适用于 `node_modules/` 安装方式）

### 可用配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `allowAllUsers` | boolean | `false` | 若为 `true`，所有真实玩家都会被视为**普通用户**（不是超管）。除非本地/单机测试服，否则不要开。 |
| `normalUserIds` | string[] | `[]` | 普通用户的 User ID 列表（如 `["1", "4"]`）。仅当 `allowAllUsers=false` 时生效。 |
| `normalUsernames` | string[] | `[]` | 普通用户的用户名列表。区分大小写。 |
| `superAdminUserIds` | string[] | `[]` | 超管的 User ID 列表。 |
| `superAdminUsernames` | string[] | `[]` | 超管的用户名列表。区分大小写。 |
| `superAdminUsersCodeSelfOnly` | boolean | `true` | 若为 `true`，即便是超管也不允许读/改其他用户在 `users.code` 里的代码（隐私保护）。 |
| `allowedCodePrefixes` | string[] | `[]` | 如果不为空，只允许执行以这些前缀开头的代码字符串。 |
| `maxCodeLength` | number | `2000` | 每次调用允许的 CLI 代码最大长度。 |
| `maxOutputLines` | number | `60` | 返回给玩家控制台的最大输出行数。 |
| `evalTimeoutMs` | number | `2000` | 同步代码执行的 Node vm 超时时间（毫秒）。 |
| `promiseTimeoutMs` | number | `5000` | 等待返回的 Promise/thenable 结果的超时时间（毫秒）。 |

> **注意**：用户名匹配**区分大小写**，请确保使用与注册时完全一致的用户名。

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

### 常用命令

#### 修改所有墙的血量

```js
Game.cli.exec("(function(){var hp=300000000;return storage.db.rooms.find({}).then(function(rs){var rooms=(rs||[]).map(function(r){return r._id});return storage.db['rooms.objects'].find({type:'rampart',room:{$in:rooms}}).then(function(ws){var p=storage.db['rooms.objects'].count({_id:{$in:[]}});(ws||[]).forEach(function(w){p=p.then(function(){return storage.db['rooms.objects'].update({_id:w._id},{$set:{hits:hp,hitsMax:hp}});});});return p.then(function(){return 'OK ramparts='+(ws?ws.length:0);});});});})()")
```

#### 修改指定房间内的墙血量（如 W4N1）

```js
Game.cli.exec("storage.db['rooms.objects'].find({ type: { $in: ['constructedWall', 'rampart'] }, room: { $in: ['W4N1'] } }).then(resp => resp.map(cs => storage.db['rooms.objects'].findOne({ _id: cs._id }).then(csDetail => storage.db['rooms.objects'].update({ _id: cs._id }, { $set: { hits: 10000000 } }))))")
```

#### 修改房间安全模式（SafeMode）结束时间

`safeMode` 字段存储的是安全模式**结束时的游戏 tick 数**。传入 `null` 可以立即结束安全模式。

```js
// 设置在第 50000 tick 结束
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: 'W1N9' }, { $set: { safeMode: 50000 } })")

// 立即结束安全模式
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: 'W1N9' }, { $set: { safeMode: null } })")

// 批量修改多个房间
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: { $in: ['W1N9', 'W2N9', 'W3N9'] } }, { $set: { safeMode: 60000 } }, { multi: true })")
```

#### 修改 Spawn 孵化剩余时间

Spawn 的 `spawning.spawnTime` 字段存储的是孵化**结束时的游戏 tick 数**。

```js
// 立即完成房间内所有 spawn 的孵化（设置为当前 tick）
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'spawn', room: 'W1N9', spawning: { $exists: true, $ne: null } }, { $set: { 'spawning.spawnTime': 63570 } }, { multi: true })")

// 立即完成指定 spawn 的孵化
Game.cli.exec("storage.db['rooms.objects'].update({ _id: '697eeead116fd4004e484b9c' }, { $set: { 'spawning.spawnTime': 63570 } })")

// 延长孵化时间（设置到指定 tick 结束）
Game.cli.exec("storage.db['rooms.objects'].update({ _id: '697ef513f24f06005e1a47b1' }, { $set: { 'spawning.spawnTime': 63600 } })")

// 取消孵化
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'spawn', room: 'W1N9' }, { $set: { spawning: null } }, { multi: true })")
```

#### 修改 Creep 寿命

Creep 的 `ageTime` 字段存储的是 creep **死亡时的游戏 tick 数**。

```js
// 延长寿命（设置到第 70000 tick 死亡）
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'creep', name: '7c9kp-班尼特-6fwjp' }, { $set: { ageTime: 70000 } })")

// 立即死亡（设置为当前 tick 或更小的值）
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'creep', name: '7c9kp-班尼特-6fwjp' }, { $set: { ageTime: 63570 } })")

// 批量延长房间内所有己方 creep 的寿命
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'creep', room: 'W1N9', user: 'your_username' }, { $set: { ageTime: 70000 } }, { multi: true })")

// 通过 _id 修改
Game.cli.exec("storage.db['rooms.objects'].update({ _id: 'creep_id_here' }, { $set: { ageTime: 70000 } })")

// 查询当前 creep 的死亡时间
Game.cli.exec("storage.db['rooms.objects'].findOne({ type: 'creep', name: '7c9kp-班尼特-6fwjp' }).then(function(c) { return { name: c.name, ageTime: c.ageTime }; })")
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
  - 在 `execute-cli.config.json` 中把你的 userId / 用户名加入 `normalUserIds/normalUsernames` 或 `superAdminUserIds/superAdminUsernames`。
- **输出缺失/被截断**：
  - 调整 `maxOutputLines`、`evalTimeoutMs`、`promiseTimeoutMs`。

## License

MIT