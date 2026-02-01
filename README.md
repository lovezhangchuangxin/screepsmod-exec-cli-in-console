# screepsmod-exec-cli-in-console

[English](./README.md) | [中文](./README.zh.md)

Allow players to execute **(some)** Screeps server **CLI-only** commands from the **in-game console**.

This mod injects `Game.cli.exec(code)` into the player sandbox, queues the request on the server, executes the code inside the server CLI sandbox, and streams output back to the player console.

## Features

- Run server CLI JS from in-game console: `Game.cli.exec('help()')`
- Built-in helpers:
  - `Game.cli.help()`
  - `Game.cli.setStore(target, store)`
  - `Game.cli.setStoreHuge(target)`
  - `Game.cli.setControllerLevel(target, level)`
  - `Game.cli.finishConstructionSites(rooms)`
- **Security-first** by default:
  - **Deny by default** (you must explicitly allow users)
  - Two roles: **normal** and **super admin**
  - Optional `allowedCodePrefixes` allow-list
  - Output length + execution time limits

## Installation

Install like a normal Screeps private-server mod:

1. Put this package under your server `mods/` folder (or install it via npm/pnpm/yarn inside your server folder).
2. Enable it in your server `mods.json`.

Example `mods.json`:

```json
{
  "mods": [
    "screepsmod-auth",
    "screepsmod-admin-utils",
    "screepsmod-exec-cli-in-console"
  ]
}
```

## Configuration (IMPORTANT)

Create a `execute-cli.config.json` file in your server root directory (same level as `mods.json`). Only include the fields you want to override; missing fields use defaults.

Example `execute-cli.config.json`:

```json
{
  "allowAllUsers": false,
  "normalUsernames": ["player1", "player2"],
  "superAdminUsernames": ["admin"],
  "superAdminUserIds": ["1"]
}
```

Config file search order:
1. Directory of `MODFILE` env var (Screeps server sets this to `mods.json` path)
2. Current working directory (`process.cwd()`)
3. One level up from the mod directory
4. Two/three levels up (for `node_modules/` installations)

### Available options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowAllUsers` | boolean | `false` | If `true`, every real player becomes a **normal** user (NOT super admin). Keep `false` unless this is a local/dev server. |
| `normalUserIds` | string[] | `[]` | User IDs for **normal** users (e.g. `["1", "4"]`). Used when `allowAllUsers=false`. |
| `normalUsernames` | string[] | `[]` | Usernames for **normal** users. Case-sensitive. |
| `superAdminUserIds` | string[] | `[]` | User IDs for **super admin** users. |
| `superAdminUsernames` | string[] | `[]` | Usernames for **super admin** users. Case-sensitive. |
| `superAdminUsersCodeSelfOnly` | boolean | `true` | If `true`, even super admins cannot read/modify other users' code in `users.code`. |
| `allowedCodePrefixes` | string[] | `[]` | If non-empty, only code starting with one of these prefixes is allowed. |
| `maxCodeLength` | number | `2000` | Maximum length of CLI code string allowed per call. |
| `maxOutputLines` | number | `60` | Maximum number of output lines sent back to the player's console. |
| `evalTimeoutMs` | number | `2000` | Node vm timeout (ms) for synchronous code execution. |
| `promiseTimeoutMs` | number | `5000` | Timeout (ms) for waiting on returned promise/thenable results. |

> **Note**: Username matching is **case-sensitive**. Make sure to use the exact username as registered.

## Usage (in-game console)

### Quick start

```js
Game.cli.help()
Game.cli.exec('help()')
```

### Run CLI helpers

```js
Game.cli.exec('system.getTickDuration()')
```

### Update `rooms.objects.store`

`target` can be `_id`, `id`, or an object containing `_id`/`id`.

```js
Game.cli.setStore('679f...67f3', { energy: 1000 })
Game.cli.setStoreHuge('679f...67f3')
```

### Set controller level

```js
Game.cli.setControllerLevel('67c8...df8', 8)
```

### Finish construction sites (almost done)

Sets `progress = progressTotal - 1` for construction sites in the given rooms.

```js
Game.cli.finishConstructionSites(['W1N9'])
```

### Common commands

#### Modify all ramparts HP

```js
Game.cli.exec("(function(){var hp=300000000;return storage.db.rooms.find({}).then(function(rs){var rooms=(rs||[]).map(function(r){return r._id});return storage.db['rooms.objects'].find({type:'rampart',room:{$in:rooms}}).then(function(ws){var p=storage.db['rooms.objects'].count({_id:{$in:[]}});(ws||[]).forEach(function(w){p=p.then(function(){return storage.db['rooms.objects'].update({_id:w._id},{$set:{hits:hp,hitsMax:hp}});});});return p.then(function(){return 'OK ramparts='+(ws?ws.length:0);});});});})()")
```

#### Modify walls/ramparts HP in a specific room (e.g. W4N1)

```js
Game.cli.exec("storage.db['rooms.objects'].find({ type: { $in: ['constructedWall', 'rampart'] }, room: { $in: ['W4N1'] } }).then(resp => resp.map(cs => storage.db['rooms.objects'].findOne({ _id: cs._id }).then(csDetail => storage.db['rooms.objects'].update({ _id: cs._id }, { $set: { hits: 10000000 } }))))")
```

#### Modify room SafeMode end time

The `safeMode` field stores the **game tick** when safe mode **ends**. Pass `null` to end safe mode immediately.

```js
// Set to end at tick 50000
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: 'W1N9' }, { $set: { safeMode: 50000 } })")

// End safe mode immediately
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: 'W1N9' }, { $set: { safeMode: null } })")

// Bulk update multiple rooms
Game.cli.exec("storage.db['rooms.objects'].update({ type: 'controller', room: { $in: ['W1N9', 'W2N9', 'W3N9'] } }, { $set: { safeMode: 60000 } }, { multi: true })")
```

## Security notes

Executing arbitrary server CLI JS is powerful:

- CLI sandbox can access server internals like `storage.*` and `system.*`.
- This mod is **DENY BY DEFAULT**. Do not enable it for public servers unless you understand the risks.

Role behavior:

- **Normal users**: CLI sandbox is restricted:
  - `storage` is replaced with a restricted wrapper (mostly limited to their own rooms/objects)
  - `system/map/bots/strongholds` are removed
- **Super admins**: full CLI sandbox access (optionally with `users.code` self-only privacy guard)

## Troubleshooting

- **`Game.cli` is undefined**:
  - Make sure the mod is enabled in `mods.json` and the server restarted.
  - Ensure your server has `isolated-vm` available (Screeps uses it for player sandbox).
- **`[cli] denied: not allowed user`**:
  - Add your user id / username to `normalUserIds/normalUsernames` or `superAdminUserIds/superAdminUsernames` in `execute-cli.config.json`.
- **No output / output truncated**:
  - Adjust `maxOutputLines`, `evalTimeoutMs`, `promiseTimeoutMs`.

## License

MIT