import { test } from "vitest";
import assert from "node:assert/strict";
import { evaluate, validateConfig } from "../src/backend/policy.js";

const config = validateConfig({ hostId: 1, node: "pve-1", vmid: 101, idleCpuPercent: 5, maxUptimeMinutes: 120 });
assert.equal(config.type, "qemu");
assert.equal(validateConfig({ ...config, type: "lxc" }).type, "lxc");
assert.equal(validateConfig({ ...config, connectionHostId: 74 }).connectionHostId, 74);
const now = 1_000_000_000;
const armed = { requestedAt: now - 900_000, bootEpoch: now - 900_000, idleSamples: 0 };

test("low CPU must persist for five checks after the boot grace period", () => {
  let current = armed;
  for (let i = 0; i < 4; i++) {
    const result = evaluate({ status: "running", uptime: 900, cpu: 0.02 }, current, config, now);
    assert.equal(result.action, "continue");
    current = { ...current, ...result };
  }
  assert.equal(evaluate({ status: "running", uptime: 900, cpu: 0.02 }, current, config, now).action, "shutdown");
  assert.equal(evaluate({ status: "running", uptime: 900, cpu: 0.2 }, current, config, now).idleSamples, 0);
  assert.equal(evaluate({ status: "running", uptime: 100, cpu: 0.01 }, { ...armed, bootEpoch: null }, config, now).idleSamples, 0);
});

test("uptime stops the VM even when CPU is busy", () => {
  assert.equal(evaluate({ status: "running", uptime: 7200, cpu: 0.9 }, { ...armed, bootEpoch: now - 7_200_000 }, config, now).action, "shutdown");
});

test("external restart disarms; missing CPU never triggers idle shutdown", () => {
  assert.equal(evaluate({ status: "running", uptime: 900, cpu: 0.01 }, { ...armed, bootEpoch: now - 10_000_000 }, config, now).action, "disarm");
  assert.equal(evaluate({ status: "running", uptime: 900 }, { ...armed, idleSamples: 4 }, config, now).idleSamples, 0);
});

test("start and shutdown requests remain pending until Proxmox confirms a stop", () => {
  assert.equal(evaluate({ status: "stopped" }, { ...armed, requestedAt: now - 60_000 }, config, now).action, "continue");
  assert.equal(evaluate({ status: "running", uptime: 900, cpu: 0.01 }, { ...armed, shutdownRequestedAt: now - 60_000, idleSamples: 4 }, config, now).action, "continue");
  assert.equal(evaluate({ status: "stopped" }, { ...armed, shutdownRequestedAt: now - 60_000 }, config, now).action, "disarm");
});

test("invalid configuration cannot reach command construction", () => {
  assert.throws(() => validateConfig({ ...config, node: "pve;shutdown" }));
  assert.throws(() => validateConfig({ ...config, vmid: 0 }));
  assert.throws(() => validateConfig({ ...config, type: "lxc;shutdown" }));
  assert.throws(() => validateConfig({ ...config, connectionHostId: 0 }));
  assert.throws(() => validateConfig({ ...config, connectionHostId: config.hostId }));
  assert.throws(() => validateConfig({ ...config, idleCpuPercent: 0, maxUptimeMinutes: 0 }));
});
