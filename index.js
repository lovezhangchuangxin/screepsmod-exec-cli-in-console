/**
 * Allow players to execute (some) server CLI-only commands from the in-game console.
 *
 * Why this is tricky:
 * - Player runtime uses `isolated-vm`, you can't inject a normal JS function via sandbox.set().
 * - But `playerSandbox` exposes the underlying isolate/context, so we can inject an
 *   `isolated-vm` Reference and call it from user code.
 *
 * SECURITY WARNING:
 * Running arbitrary CLI JS gives full access to the server database (`storage.*`) and
 * system controls (`system.pauseSimulation()`, etc). This mod is **DENY BY DEFAULT**.
 * Add your admin user ids/usernames to SETTINGS below before using.
 */

'use strict';

const path = require('path');
const EventEmitter = require('events').EventEmitter;
const vm = require('vm');
const util = require('util');

// ---- Settings (edit me) ----------------------------------------------------

const SETTINGS = {
    /**
     * If true, EVERY real player is treated as a "normal" allowed user (see `resolveRole()`),
     * i.e. they can call `Game.cli.exec()` without being in `normalUserIds/normalUsernames`.
     *
     * IMPORTANT: This does NOT grant "super admin" capabilities. Normal users get a restricted
     * CLI sandbox (see `getCliSandbox()`):
     * - `storage` is replaced with a restricted wrapper (mostly limited to their own rooms/objects)
     * - `system/map/bots/strongholds` are removed
     *
     * Keep it false unless this server is a single-player/dev sandbox.
     */
    allowAllUsers: false,

    /**
     * Normal permission allow-list (used only when allowAllUsers=false).
     * Normal users can ONLY access:
     * - storage.db.rooms (restricted to rooms they own)
     * - storage.db.objects / storage.db['rooms.objects'] (restricted to {user: self})
     * - storage.db.creeps (view over rooms.objects with {type:'creep', user:self})
     */
    normalUserIds: [],
    normalUsernames: [],

    /**
     * Super admin allow-list.
     * Super admins can execute any CLI JS and access all CLI sandbox objects.
     */
    superAdminUserIds: [],
    superAdminUsernames: [],

    /**
     * Privacy guard:
     * Even for super admins, do NOT allow reading/modifying other users' code in `users.code`.
     * (Super admins can still access other tables unless you restrict them elsewhere.)
     */
    superAdminUsersCodeSelfOnly: true,

    /**
     * Optional prefix allow-list for the CLI JS string.
     * If non-empty, only commands starting with one of these prefixes will be allowed.
     *
     * Examples:
     * - ['system.', 'map.']          -> allow only system.* and map.* helpers
     * - ['help(', 'print(']          -> allow only help()/print()
     * - []                          -> allow any JS (still subject to user allow-list)
     */
    allowedCodePrefixes: [],

    /**
     * Basic abuse limits.
     */
    maxCodeLength: 2000,
    maxOutputLines: 60,
    evalTimeoutMs: 2000, // Node vm timeout for sync execution
    promiseTimeoutMs: 5000, // waiting for returned promise/thenable
};

// ---------------------------------------------------------------------------

// In Steam-distributed Screeps server, dependencies may live under `package/node_modules/`
// instead of the normal top-level `node_modules/`. This helper makes the mod loadable in both.
function req(name) {
    try {
        // eslint-disable-next-line import/no-dynamic-require, global-require
        return require(name);
    } catch (e) {
        // eslint-disable-next-line import/no-dynamic-require, global-require
        return require(path.resolve(__dirname, '..', 'package', 'node_modules', name));
    }
}

const common = req('@screeps/common');
const q = req('q');
let ivm; // lazy-loaded (native module)
let ObjectId; // optional, for Mongo-backed servers

function getIvm() {
    if (ivm) return ivm;
    try {
        ivm = req('isolated-vm');
        return ivm;
    } catch (e) {
        console.error('[execute-cli mod] cannot load isolated-vm:', e && (e.stack || e));
        return null;
    }
}

function getObjectId() {
    if (ObjectId) return ObjectId;
    // Optional dependency: in some servers (MongoDB), ObjectId exists.
    try {
        const mongodb = req('mongodb');
        ObjectId = mongodb && (mongodb.ObjectId || (mongodb.BSON && mongodb.BSON.ObjectId));
        return ObjectId;
    } catch (e) {}
    try {
        const bson = req('bson');
        ObjectId = bson && bson.ObjectId;
        return ObjectId;
    } catch (e) {}
    return null;
}

function normalizeList(list) {
    return (Array.isArray(list) ? list : [])
        .map(i => (i === null || i === undefined) ? '' : String(i))
        .map(i => i.trim())
        .filter(Boolean);
}

function isNpcUserId(userId) {
    // In this codebase, "2" and "3" are used for NPCs in driver.sendConsoleMessages
    return userId === '2' || userId === '3';
}

function normalizeIdSet(list) {
    return new Set(normalizeList(list));
}

function normalizeNameSet(list) {
    return new Set(normalizeList(list));
}

function getEffectiveSuperAdminSets() {
    return {
        ids: normalizeIdSet(SETTINGS.superAdminUserIds),
        names: normalizeNameSet(SETTINGS.superAdminUsernames),
    };
}

function getEffectiveNormalSets() {
    return {
        ids: normalizeIdSet(SETTINGS.normalUserIds),
        names: normalizeNameSet(SETTINGS.normalUsernames),
    };
}

function isUpdateTryingToChangeUser(updateDoc, userId) {
    if (!updateDoc || typeof updateDoc !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(updateDoc, 'user')) {
        return String(updateDoc.user) !== String(userId);
    }
    const ops = ['$set', '$merge', '$unset'];
    for (const op of ops) {
        const part = updateDoc[op];
        if (!part || typeof part !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(part, 'user')) {
            if (op === '$unset') return true;
            return String(part.user) !== String(userId);
        }
    }
    return false;
}

function makeRestrictedDbForUser(userId) {
    userId = String(userId);
    const db = common.storage.db;

    const OID = getObjectId();
    const looksLikeObjectId = /^[a-f\d]{24}$/i.test(userId);
    const userMatch = (() => {
        if (OID && looksLikeObjectId) {
            try {
                const oid = new OID(userId);
                return {$or: [{user: userId}, {user: oid}]};
            } catch (e) {}
        }
        return {user: userId};
    })();

    let ownedRoomsPromise;
    function ownedRoomIds() {
        if (!ownedRoomsPromise) {
            // Prefer simple queries for compatibility with different storage backends.
            ownedRoomsPromise = q.when()
                .then(() => db['rooms.objects'].find({type: 'controller', user: userId}))
                .then((controllers) => {
                    if (controllers && controllers.length) return controllers;
                    if (OID && looksLikeObjectId) {
                        try {
                            return db['rooms.objects'].find({type: 'controller', user: new OID(userId)});
                        } catch (e) {}
                    }
                    return controllers || [];
                })
                .then((controllers) => (controllers || []).map(i => i.room).filter(Boolean));
        }
        return ownedRoomsPromise;
    }

    function andQuery(q1, q2) {
        if (!q1) return q2;
        if (!q2) return q1;
        return {$and: [q1, q2]};
    }

    function forbid(msg) {
        return q.reject(new Error(msg));
    }

    function wrapRooms() {
        const col = db.rooms;
        return {
            find(query, opts) {
                return ownedRoomIds().then(roomIds => col.find(andQuery(query, {_id: {$in: roomIds}}), opts));
            },
            findOne(query, opts) {
                return ownedRoomIds().then(roomIds => col.findOne(andQuery(query, {_id: {$in: roomIds}}), opts));
            },
            count(query) {
                return ownedRoomIds().then(roomIds => col.count(andQuery(query, {_id: {$in: roomIds}})));
            },
            findEx(query, opts) {
                return ownedRoomIds().then(roomIds => col.findEx(andQuery(query, {_id: {$in: roomIds}}), opts));
            },
            update(query, updateDoc, params) {
                return ownedRoomIds().then(roomIds => col.update(andQuery(query, {_id: {$in: roomIds}}), updateDoc, params));
            },
            insert() { return forbid('rooms.insert is not allowed for normal users'); },
            removeWhere() { return forbid('rooms.removeWhere is not allowed for normal users'); },
            clear() { return forbid('rooms.clear is not allowed for normal users'); },
            by() { return forbid('rooms.by is not allowed for normal users'); },
            ensureIndex() { return forbid('rooms.ensureIndex is not allowed for normal users'); },
            bulk() { return forbid('rooms.bulk is not allowed for normal users'); },
        };
    }

    function wrapRoomObjects(extraQuery, name) {
        const col = db['rooms.objects'];
        const base = andQuery(extraQuery, userMatch);

        function mapInsert(obj) {
            const out = Object.assign({}, obj);
            if (out.user && String(out.user) !== userId) {
                throw new Error(`${name}.insert denied: user mismatch`);
            }
            out.user = userId;
            return out;
        }

        return {
            find(query, opts) { return col.find(andQuery(query, base), opts); },
            findOne(query, opts) { return col.findOne(andQuery(query, base), opts); },
            count(query) { return col.count(andQuery(query, base)); },
            findEx(query, opts) { return col.findEx(andQuery(query, base), opts); },
            update(query, updateDoc, params) {
                if (isUpdateTryingToChangeUser(updateDoc, userId)) {
                    return forbid(`${name}.update denied: cannot change user field`);
                }
                // Mongo-backed servers may store `user` as ObjectId. Complex `$and/$or` queries can behave
                // differently across backends. To keep "normal" permissions usable, do:
                // 1) Require `_id` update
                // 2) Verify ownership by reading the object
                // 3) Update by `_id` only
                if (!query || typeof query !== 'object' || typeof query._id === 'undefined') {
                    return forbid(`${name}.update denied: normal users must update by _id`);
                }
                return q.when(col.findOne({_id: query._id}))
                    .then((obj) => {
                        if (!obj) {
                            return {n: 0, nModified: 0, ok: 1};
                        }
                        if (String(obj.user) !== String(userId)) {
                            return forbid(`${name}.update denied: not owner`);
                        }
                        if (extraQuery && extraQuery.type && obj.type !== extraQuery.type) {
                            return forbid(`${name}.update denied: wrong type`);
                        }
                        return col.update({_id: query._id}, updateDoc, params);
                    });
            },
            removeWhere(query) { return col.removeWhere(andQuery(query, base)); },
            insert(objOrArr) {
                try {
                    const arr = Array.isArray(objOrArr) ? objOrArr : [objOrArr];
                    const mapped = arr.map(mapInsert);
                    return col.insert(Array.isArray(objOrArr) ? mapped : mapped[0]);
                } catch (e) {
                    return q.reject(e);
                }
            },
            clear() { return forbid(`${name}.clear is not allowed for normal users`); },
            by() { return forbid(`${name}.by is not allowed for normal users`); },
            ensureIndex() { return forbid(`${name}.ensureIndex is not allowed for normal users`); },
            bulk() { return forbid(`${name}.bulk is not allowed for normal users`); },
        };
    }

    const objects = wrapRoomObjects(null, 'objects');
    const creeps = wrapRoomObjects({type: 'creep'}, 'creeps');

    return Object.create(null, {
        rooms: {value: wrapRooms(), enumerable: true},
        objects: {value: objects, enumerable: true},
        creeps: {value: creeps, enumerable: true},
        'rooms.objects': {value: objects, enumerable: true},
    });
}

function makeRestrictedStorageForUser(userId) {
    return {db: makeRestrictedDbForUser(userId)};
}

function makeUsersCodeSelfOnlyWrapper(usersCodeCollection, userId) {
    userId = String(userId);
    function andQuery(q1, q2) {
        if (!q1) return q2;
        if (!q2) return q1;
        return {$and: [q1, q2]};
    }
    function forbid(msg) {
        return q.reject(new Error(msg));
    }
    function mapInsert(obj) {
        const out = Object.assign({}, obj);
        if (out.user && String(out.user) !== userId) {
            throw new Error(`users.code.insert denied: cannot set user != self`);
        }
        out.user = userId;
        return out;
    }
    return {
        find(query, opts) { return usersCodeCollection.find(andQuery(query, {user: userId}), opts); },
        findOne(query, opts) { return usersCodeCollection.findOne(andQuery(query, {user: userId}), opts); },
        count(query) { return usersCodeCollection.count(andQuery(query, {user: userId})); },
        findEx(query, opts) { return usersCodeCollection.findEx(andQuery(query, {user: userId}), opts); },
        update(query, updateDoc, params) {
            if (isUpdateTryingToChangeUser(updateDoc, userId)) {
                return forbid('users.code.update denied: cannot change user field');
            }
            return usersCodeCollection.update(andQuery(query, {user: userId}), updateDoc, params);
        },
        removeWhere(query) { return usersCodeCollection.removeWhere(andQuery(query, {user: userId})); },
        insert(objOrArr) {
            try {
                const arr = Array.isArray(objOrArr) ? objOrArr : [objOrArr];
                const mapped = arr.map(mapInsert);
                return usersCodeCollection.insert(Array.isArray(objOrArr) ? mapped : mapped[0]);
            } catch (e) {
                return q.reject(e);
            }
        },
        clear() { return forbid('users.code.clear is not allowed'); },
        by() { return forbid('users.code.by is not allowed'); },
        ensureIndex() { return forbid('users.code.ensureIndex is not allowed'); },
        bulk() { return forbid('users.code.bulk is not allowed'); },
    };
}

function toConsoleLines(value) {
    if (value === undefined) return [];
    if (typeof value === 'string') return [value];
    return [util.inspect(value, {depth: 3, maxArrayLength: 50})];
}

function sendConsole(config, userId, lines, {asResult = false} = {}) {
    if (!config || !config.engine || !config.engine.driver || !lines || !lines.length) return;
    const payload = asResult ? {log: [], results: lines} : {log: lines, results: []};
    try {
        config.engine.driver.sendConsoleMessages(userId, payload);
    } catch (e) {
        // Avoid crashing runner loop because of console output issues.
        console.error('[execute-cli mod] sendConsoleMessages failed:', e && (e.stack || e));
    }
}

function getCliSandbox(config, outputCallback, opts) {
    opts = opts || {};
    // Ensure config.cli exists even in non-backend processes (runner/processor).
    if (!config.cli) {
        config.cli = new EventEmitter();
    }

    // Patch config.cli.createSandbox (backend normally does this in @screeps/backend startup).
    // We require it lazily to avoid side effects if this mod is loaded in processes that don't need it.
    req('@screeps/backend/lib/cli/sandbox');

    const sandbox = common.configManager.config.cli.createSandbox((data, isResult) => {
        outputCallback(data, isResult);
    });

    if (opts.role === 'normal') {
        sandbox.storage = makeRestrictedStorageForUser(opts.userId);
        sandbox.system = undefined;
        sandbox.map = undefined;
        sandbox.bots = undefined;
        sandbox.strongholds = undefined;
    }
    else if (opts.role === 'super' && SETTINGS.superAdminUsersCodeSelfOnly) {
        // Keep full CLI capabilities, but protect user code privacy.
        // IMPORTANT: do NOT mutate global `common.storage` (cli sandbox uses it by reference).
        // Otherwise, after a super admin runs CLI once, the whole process would be unable to
        // load other users' code (e.g. "main not found").
        if (sandbox.storage && sandbox.storage.db && sandbox.storage.db['users.code']) {
            const storageClone = Object.assign({}, sandbox.storage);
            storageClone.db = Object.assign({}, sandbox.storage.db);
            storageClone.db['users.code'] = makeUsersCodeSelfOnlyWrapper(sandbox.storage.db['users.code'], opts.userId);
            sandbox.storage = storageClone;
        }
    }

    // Fresh context per call (safer than keeping a persistent one).
    const context = vm.createContext(sandbox);
    return {sandbox, context};
}

function checkAllowed(config, userId, code) {
    if (!userId || isNpcUserId(userId)) {
        return {ok: false, reason: 'NPC user is not allowed'};
    }

    if (typeof code !== 'string' || !code.trim()) {
        return {ok: false, reason: 'empty code'};
    }
    if (code.length > SETTINGS.maxCodeLength) {
        return {ok: false, reason: `code too long (>${SETTINGS.maxCodeLength})`};
    }

    const prefixes = normalizeList(SETTINGS.allowedCodePrefixes);
    if (prefixes.length) {
        const ok = prefixes.some(p => code.trim().startsWith(p));
        if (!ok) {
            return {ok: false, reason: `code prefix not allowed (allowed: ${prefixes.join(', ')})`};
        }
    }

    return {ok: true};
}

async function resolveRole(userId) {
    userId = String(userId);
    const superSets = getEffectiveSuperAdminSets();
    const normalSets = getEffectiveNormalSets();
    const defaultRole = SETTINGS.allowAllUsers ? 'normal': null

    if (superSets.ids.has(userId)) return 'super';
    if (normalSets.ids.has(userId)) return 'normal';

    const needNameLookup = superSets.names.size > 0 || normalSets.names.size > 0;
    if (!needNameLookup) return defaultRole;

    const user = await common.storage.db.users.findOne({_id: userId});
    const usernameLower = user && user.username ? String(user.username) : '';
    if (usernameLower && superSets.names.has(usernameLower)) return 'super';
    if (usernameLower && normalSets.names.has(usernameLower)) return 'normal';
    return defaultRole;
}

function withTimeout(promise, ms, label) {
    // Use `q` here since some older Node versions in Screeps runtime don't support Promise.prototype.finally.
    if (!promise || typeof promise.then !== 'function') {
        return q.when(promise);
    }
    return q.race([
        q.when(promise),
        q.delay(ms).then(() => ({__timeout: true, label})),
    ]);
}

async function runCliForUser(config, userId, code) {
    const check = checkAllowed(config, userId, code);
    if (!check.ok) {
        sendConsole(config, userId, [`[cli] denied: ${check.reason}`], {asResult: true});
        return;
    }

    const role = await resolveRole(userId);
    if (!role) {
        sendConsole(config, userId, [`[cli] denied: not allowed user`], {asResult: true});
        return;
    }

    let outLines = [];
    const pushLine = (line, isResult) => {
        if (outLines.length >= SETTINGS.maxOutputLines) return;
        outLines.push(String(line));
        // Flush progressively to the player's console (feels more like real CLI).
        sendConsole(config, userId, [String(line)], {asResult: !!isResult});
    };

    try {
        const {context} = getCliSandbox(config, (data, isResult) => pushLine(data, isResult), {role, userId});

        // Execute. `timeout` here prevents sync infinite loops.
        const result = vm.runInContext(code, context, {timeout: SETTINGS.evalTimeoutMs});

        // If returned a promise/thenable, wait a bit and show its result (or timeout).
        if (result && typeof result.then === 'function') {
            const awaited = await withTimeout(result, SETTINGS.promiseTimeoutMs, 'promise');
            if (awaited && awaited.__timeout) {
                pushLine(`[cli] promise not resolved within ${SETTINGS.promiseTimeoutMs}ms`, true);
            } else if (awaited !== undefined) {
                toConsoleLines(awaited).forEach(l => pushLine(l, true));
            }
        } else if (result !== undefined) {
            toConsoleLines(result).forEach(l => pushLine(l, true));
        }
    }
    catch (e) {
        pushLine(`[cli] Error: ${(e && (e.stack || e))}`, true);
    }
    finally {
        if (outLines.length >= SETTINGS.maxOutputLines) {
            sendConsole(config, userId, [`[cli] output truncated (>${SETTINGS.maxOutputLines} lines)`], {asResult: true});
        }
    }
}

module.exports = function(config) {
    if (!config || !config.engine) {
        return;
    }

    const _ivm = getIvm();
    if (!_ivm) {
        // If isolated-vm cannot be loaded in this process, we can't inject host callbacks.
        return;
    }

    // Ensure config.cli exists early, so other mods loaded AFTER this one can attach `cliSandbox` listeners
    // even in runner processes (optional, but helpful).
    if (!config.cli) {
        config.cli = new EventEmitter();
    }

    config.engine.on('playerSandbox', function(sandbox, userId) {
        // Inject a host callback into player's isolate.
        const ctx = sandbox.getContext();
        const refName = '__playerCliExec';

        // A synchronous "enqueue" wrapper, to allow calling it from user console without async plumbing.
        // The real execution happens async and writes outputs to the in-game console.
        const enqueueFn = function(code) {
            try {
                // Do not block the isolate; run on next tick in Node.
                setImmediate(() => {
                    runCliForUser(config, String(userId), String(code));
                });
            } catch (e) {
                console.error('[execute-cli mod] enqueue failed:', e && (e.stack || e));
            }
            return '[cli] queued';
        };

        try {
            ctx.global.setIgnored(refName, new _ivm.Reference(enqueueFn));

            // Attach a nice API for players.
            // Usage in in-game console:
            //   Game.cli.exec('help()')
            //   Game.cli.exec('system.getTickDuration()')
            sandbox.run(`
                (function() {
                    if(typeof Game !== 'object' || !Game) return;
                    Game.cli = Game.cli || Object.create(null);
                    Game.cli.exec = function(code) {
                        return global.${refName}.applySync(undefined, [String(code)], {
                            arguments: { copy: true },
                            result: { copy: true }
                        });
                    };
                    Game.cli._normalizeId = function(target) {
                        if(!target) return target;
                        if(typeof target === 'string') return target;
                        if(typeof target === 'object') {
                            if(target._id) return String(target._id);
                            if(target.id) return String(target.id);
                        }
                        return String(target);
                    };

                    // Set store field for a rooms.objects item (by _id / id / object).
                    // Example:
                    //   Game.cli.setStore('679f...67f3', {energy: 1000})
                    Game.cli.setStore = function(target, store) {
                        var id = Game.cli._normalizeId(target);
                        var storeJson = JSON.stringify(store || {});
                        return Game.cli.exec(
                            "storage.db['rooms.objects'].update({ _id: " + JSON.stringify(id) + " }, { $set: { store: " + storeJson + " } })"
                        );
                    };

                    // Preset: huge store (useful for local testing / cheating).
                    // This just calls setStore() with a predefined payload.
                    Game.cli.setStoreHuge = function(target) {
                        return Game.cli.setStore(target, {
                            energy: 5000000,
                            power: 100000,
                            ops: 100000,
                            XUHO2: 100000,
                            XUH2O: 100000,
                            XKH2O: 100000,
                            XKHO2: 100000,
                            XLH2O: 100000,
                            XLHO2: 100000,
                            XZH2O: 100000,
                            XZHO2: 100000,
                            XGH2O: 100000,
                            XGHO2: 100000,
                            X: 100000,
                            O: 100000,
                            H: 100000,
                            Z: 100000,
                            L: 100000,
                            K: 100000,
                            U: 100000
                        });
                    };

                    // Set controller level by rooms.objects _id / object.
                    // Example:
                    //   Game.cli.setControllerLevel('67c8...df8', 8)
                    Game.cli.setControllerLevel = function(target, level) {
                        var id = Game.cli._normalizeId(target);
                        var lvl = parseInt(level, 10);
                        if(isNaN(lvl)) lvl = 0;
                        if(lvl < 0) lvl = 0;
                        if(lvl > 8) lvl = 8;
                        return Game.cli.exec(
                            "storage.db['rooms.objects'].update({ _id: " + JSON.stringify(id) + " }, { $set: { level: " + JSON.stringify(lvl) + " } })"
                        );
                    };

                    // Set all construction sites in given rooms to "almost done":
                    // progress = progressTotal - 1
                    // Example:
                    //   Game.cli.finishConstructionSites(['W1N9'])
                    Game.cli.finishConstructionSites = function(rooms) {
                        if(!rooms) rooms = [];
                        if(typeof rooms === 'string') rooms = [rooms];
                        var roomsJson = JSON.stringify(rooms);
                        var code =
                            "(function(){" +
                            "return storage.db['rooms.objects'].find({ type: 'constructionSite', room: { $in: " + roomsJson + " } })" +
                            ".then(function(list){" +
                            "  var p = storage.db['rooms.objects'].count({ _id: { $in: [] } });" + // an already-resolved thenable
                            "  (list||[]).forEach(function(cs){" +
                            "    p = p.then(function(){" +
                            "      var total = cs && cs.progressTotal;" +
                            "      if(typeof total === 'number') {" +
                            "        return storage.db['rooms.objects'].update({ _id: cs._id }, { $set: { progress: total - 1 } });" +
                            "      }" +
                            "      return storage.db['rooms.objects'].findOne({ _id: cs._id }).then(function(full){" +
                            "        var t = full && full.progressTotal;" +
                            "        if(typeof t !== 'number') t = 0;" +
                            "        return storage.db['rooms.objects'].update({ _id: cs._id }, { $set: { progress: t - 1 } });" +
                            "      });" +
                            "    });" +
                            "  });" +
                            "  return p.then(function(){ return 'OK'; });" +
                            "});" +
                            "})();";
                        return Game.cli.exec(code);
                    };

                    Game.cli._help = [
                        "Game.cli.exec(code): execute server CLI JS. Output will appear in your console.",
                        "Game.cli.setStore(target, store): update rooms.objects.store by id/_id/object.",
                        "Game.cli.setStoreHuge(target): set a large predefined store payload.",
                        "Game.cli.setControllerLevel(target, level): update controller level by rooms.objects _id/object.",
                        "Game.cli.finishConstructionSites(rooms): set construction sites progress to progressTotal-1 for given rooms."
                    ].join("\\n");

                    Game.cli.help = function() {
                        return Game.cli._help || "";
                    };
                })();
            `);
        }
        catch (e) {
            console.error('[execute-cli mod] playerSandbox injection failed:', e && (e.stack || e));
        }
    });
};
