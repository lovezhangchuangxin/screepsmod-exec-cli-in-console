# screepsmod-exec-cli-in-console

[English](README.md) | [中文](README.zh.md)

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

Edit `execute-cli.js` and update `SETTINGS`:

- `allowAllUsers`: if `true`, every real player becomes a **normal** user (NOT super admin). Keep `false` unless this is a local/dev server.
- `normalUserIds` / `normalUsernames`: allow-list for **normal** users when `allowAllUsers=false`.
- `superAdminUserIds` / `superAdminUsernames`: allow-list for **super** users.
- `superAdminUsersCodeSelfOnly`: if `true`, even super admins cannot read/modify other users' code in `users.code`.
- `allowedCodePrefixes`: if non-empty, only code starting with one of these prefixes is allowed.
- Limits:
  - `maxCodeLength`
  - `maxOutputLines`
  - `evalTimeoutMs`
  - `promiseTimeoutMs`

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
  - Add your user id / username to `SETTINGS.normalUserIds/normalUsernames` or `superAdmin*`.
- **No output / output truncated**:
  - Adjust `maxOutputLines`, `evalTimeoutMs`, `promiseTimeoutMs`.

## License

MIT