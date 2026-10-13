import { test } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate } from "../src/backend/index.js";

test("multiple guests keep separate start and shutdown state, including migrated armed state", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url)));
  assert.ok(manifest.capabilities.includes("users:impersonate"));
  const dir = await mkdtemp(join(tmpdir(), "termix-guests-"));
  const routes = new Map();
  const commands = [];
  const statuses = { "qemu/101": "stopped", "lxc/202": "stopped" };
  const impersonated = [];
  let tick;
  const client = {
    exec(command, callback) {
      commands.push(command);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      callback(null, stream);
      queueMicrotask(() => {
        if (command.includes("cluster/resources")) {
          stream.emit("data", JSON.stringify([{ type: "qemu", vmid: 101, node: "pve", name: "Build VM" }, { type: "lxc", vmid: 202, node: "pve", name: "Container" }]));
        } else {
          const match = command.match(/\/nodes\/pve\/(qemu|lxc)\/(\d+)\/status\/(current|start|shutdown)/);
          assert.ok(match, command);
          const key = `${match[1]}/${match[2]}`;
          if (match[3] === "current") stream.emit("data", JSON.stringify({ status: statuses[key], uptime: statuses[key] === "running" ? 7200 : 0, cpu: 0.7 }));
          else statuses[key] = match[3] === "start" ? "running" : "stopped";
        }
        stream.emit("close", 0);
      });
    },
  };
  const ctx = {
    files: { dataDir: () => dir },
    http: { router: () => ({
      use() {},
      get(path, handler) { routes.set(`GET ${path}`, handler); },
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers.at(-1)); },
    }) },
    rbac: { require: () => () => {} },
    hosts: { checkAccess: async () => true, list: async () => [
      { id: 1, name: "Proxmox" },
      { id: 2, name: "Other SSH host" },
    ] },
    settings: { getHost: async (id, key) => key === "enabled" && id === 1 },
    ssh: { connect: async () => ({ client, dispose() {} }) },
    schedule: { every(_ms, fn) { tick = fn; } },
    asUser: async (id, fn) => { impersonated.push(id); return fn(); },
    currentActor: () => "admin",
    log: { info() {}, error() {} },
  };
  const call = async (method, path, body) => {
    let output;
    let code = 200;
    const res = { status(value) { code = value; return this; }, json(value) { output = value; return this; } };
    const [pathname, search] = path.split("?");
    await routes.get(`${method} ${pathname}`)({ body, query: Object.fromEntries(new URLSearchParams(search)) }, res);
    return { code, output };
  };
  const qemu = { hostId: 1, node: "pve", vmid: 101, type: "qemu", idleCpuPercent: 5, maxUptimeMinutes: 120 };
  const lxc = { ...qemu, vmid: 202, type: "lxc" };
  try {
    await activate(ctx);
    assert.deepEqual((await call("GET", "/hosts")).output, [
      { id: 1, name: "Proxmox", proxmox: true },
      { id: 2, name: "Other SSH host", proxmox: false },
    ]);
    assert.deepEqual((await call("GET", "/vms?hostId=1")).output.map(guest => guest.name), ["Build VM", "Container"]);
    assert.equal((await call("POST", "/start", qemu)).code, 200);
    assert.equal((await call("POST", "/start", lxc)).code, 200);
    assert.equal((await call("GET", "/vm")).output.guests.filter(guest => guest.armed).length, 2);
    const again = await call("POST", "/start", { ...lxc, allowRunning: true });
    assert.equal(again.code, 200);
    assert.equal(again.output.guests.find(guest => guest.key === "1:lxc:pve:202").last.status, "running");
    assert.equal((await call("POST", "/start", lxc)).code, 409);
    await tick();
    assert.deepEqual(impersonated, ["admin", "admin"]);
    assert.ok(commands.some(command => command.includes("/qemu/101/status/shutdown")));
    assert.ok(commands.some(command => command.includes("/lxc/202/status/shutdown")));
    await tick();
    assert.equal((await call("GET", "/vm")).output.guests.filter(guest => guest.armed).length, 0);
    assert.equal((await call("POST", "/remove", { key: "1:qemu:pve:101" })).code, 200);
    assert.equal((await call("GET", "/vm")).output.guests.length, 1);
    assert.equal((await call("POST", "/refresh")).output.guests[0].last.status, "stopped");
    assert.equal((await call("POST", "/adopt", { key: "1:lxc:pve:202" })).code, 409);
    statuses["lxc/202"] = "running";
    const shutdownsBefore = commands.filter(command => command.includes("/lxc/202/status/shutdown")).length;
    assert.equal((await call("POST", "/refresh")).output.guests[0].last.status, "running");
    assert.equal(commands.filter(command => command.includes("/lxc/202/status/shutdown")).length, shutdownsBefore);
    assert.equal((await call("POST", "/adopt", { key: "1:lxc:pve:202" })).output.guests[0].armed.shutdownRequestedAt, null);
    await tick();
    assert.equal(commands.filter(command => command.includes("/lxc/202/status/shutdown")).length, shutdownsBefore + 1);
    const stored = JSON.parse(await readFile(join(dir, "vm.json"), "utf8"));
    assert.equal(stored.guests.length, 1);

    await writeFile(join(dir, "vm.json"), JSON.stringify({ config: lxc, armed: { userId: "admin", requestedAt: Date.now(), bootEpoch: null, idleSamples: 0 }, last: { status: "starting" } }));
    await activate(ctx);
    const migrated = (await call("GET", "/vm")).output.guests;
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].config.type, "lxc");
    assert.ok(migrated[0].armed);
    statuses["lxc/202"] = "running";
    await tick();
    assert.equal((await call("GET", "/vm")).output.guests[0].last.error, null);
    assert.equal((await call("POST", "/config", qemu)).code, 200);
    assert.equal((await call("GET", "/vm")).output.guests.length, 2);
    assert.equal((await call("POST", "/remove", { key: migrated[0].key })).code, 409);

    statuses["qemu/101"] = "running";
    const mapped = { ...qemu, connectionHostId: 74 };
    assert.equal((await call("POST", "/config", mapped)).output.guests.find(guest => guest.key === "1:qemu:pve:101").config.connectionHostId, 74);
    assert.equal((await call("POST", "/start", { ...mapped, allowRunning: true })).code, 200);
    assert.deepEqual((await call("POST", "/ssh-ready", { key: "1:qemu:pve:101" })).output, { ready: true });
    assert.equal((await call("POST", "/ssh-ready", { key: "1:lxc:pve:202" })).code, 404);
    const stoppedVm = await call("POST", "/stop", { key: "1:qemu:pve:101" });
    assert.equal(stoppedVm.code, 200);
    assert.equal(stoppedVm.output.guests.find(guest => guest.key === "1:qemu:pve:101").last.status, "stopping");
    assert.equal((await call("POST", "/refresh")).output.guests.find(guest => guest.key === "1:qemu:pve:101").last.status, "stopped");
    assert.equal((await call("POST", "/stop", { key: "1:qemu:pve:101" })).code, 409);

    assert.equal((await call("POST", "/disarm", { key: "1:lxc:pve:202" })).code, 200);
    assert.equal((await call("POST", "/config", { ...lxc, connectionHostId: 74 })).code, 409);
    statuses["lxc/202"] = "running";
    assert.equal((await call("POST", "/stop", { key: "1:lxc:pve:202" })).code, 200);
    assert.ok(commands.some(command => command.includes("/nodes/pve/qemu/101/status/shutdown")));
    assert.ok(commands.some(command => command.includes("/nodes/pve/lxc/202/status/shutdown")));
    statuses["lxc/202"] = "running";
    await call("POST", "/refresh");
    assert.equal((await call("POST", "/adopt", { key: "1:lxc:pve:202" })).code, 200);
    const armedStop = await call("POST", "/stop", { key: "1:lxc:pve:202" });
    assert.equal(armedStop.code, 200);
    assert.ok(armedStop.output.guests.find(guest => guest.key === "1:lxc:pve:202").armed.shutdownRequestedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
