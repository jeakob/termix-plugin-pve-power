import { test, vi } from "vitest";
import assert from "node:assert/strict";

// Running as root, chmod 000 would not fail, so the read error is mocked.
vi.mock("node:fs/promises", async importOriginal => ({
  ...(await importOriginal()),
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" })),
}));
const { activate } = await import("../src/backend/index.js");

test("activate starts empty when the state file is unreadable (EACCES)", async () => {
  const warnings = [];
  const ctx = {
    files: { dataDir: () => "/nonexistent" },
    log: { info() {}, error() {}, warn: m => warnings.push(m) },
    http: { router: () => ({ use() {}, get() {}, post() {} }) },
    rbac: { require: () => () => {} },
    schedule: { every() {} },
  };
  await activate(ctx);
  assert.equal(warnings.length, 1);
});
