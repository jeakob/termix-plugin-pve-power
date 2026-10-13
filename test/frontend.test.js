import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const locale = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"));
const lookup = key => key.split(".").reduce((node, part) => node?.[part], locale);
// Mirrors i18next: `count` picks the _one/_other form, {{name}} is filled from options.
const t = (key, options = {}) => {
  const text = lookup("count" in options ? `${key}_${options.count === 1 ? "one" : "other"}` : key) ?? lookup(key);
  assert.equal(typeof text, "string", `missing locale key ${key}`);
  return text.replace(/{{(\w+)}}/g, (_, name) => String(options[name]));
};

test("every frontend locale key exists in en.json", () => {
  const source = readFileSync(new URL("../src/frontend/index.js", import.meta.url), "utf8");
  const keys = [...source.matchAll(/(?:\bt|titleKey:)\(?\s*"([a-zA-Z.]+)"/g)].map(match => match[1]);
  // Keys picked at runtime: `status.${...}` and the guest type labels.
  keys.push("status.checking", "status.starting", "status.running", "status.stopped", "status.stopping");
  assert.ok(keys.length > 40);
  for (const key of keys) assert.equal(typeof (lookup(key) ?? lookup(`${key}_one`)), "string", `missing locale key ${key}`);
});

test("host click fetches the current guest link before opening SSH", async () => {
  const calls = [];
  const actions = {};
  const toasts = [];
  let wakeTab;
  let effects = [];
  let hookState = [];
  let hookIndex = 0;
  let resolveHandoff;
  let handoff = new Promise(resolve => { resolveHandoff = resolve; });
  const renderWake = props => {
    hookIndex = 0;
    effects = [];
    wakeTab(props);
    return effects;
  };
  const api = {
    get: async () => ({ data: { guests: [{ key: "62:lxc:pve:104", config: { hostId: 62, type: "lxc", vmid: 104, connectionHostId: 74 } }] } }),
    post: async (path, body) => {
      calls.push([path, body]);
      return { data: path === "/ssh-ready" ? { ready: true } : { guests: [{ key: "62:lxc:pve:104", last: { status: "starting" } }] } };
    },
  };
  const React = { createElement() {}, useEffect(fn) { effects.push(fn); }, useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = initial;
    return [hookState[index], value => {
      hookState[index] = value;
      if (index === 3 && value) resolveHandoff();
    }];
  } };
  const source = readFileSync(new URL("../src/frontend/index.js", import.meta.url), "utf8")
    .replace('import "./styles.css";\n', "")
    .replace('import React, { useEffect, useState } from "react";', 'const React = globalThis.__pveMocks.React; const { useEffect, useState } = React;')
    .replace('import { usePermission, usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";', 'const { usePermission, usePluginApi, useTranslation } = globalThis.__pveMocks.frontend;')
    .replace('import { PanelShell } from "@termix-ssh/plugin-sdk/ui";', 'const { PanelShell } = globalThis.__pveMocks.ui;')
    .replace('import { toast } from "sonner";', 'const { toast } = globalThis.__pveMocks.sonner;');
  globalThis.__pveMocks = {
    React,
    frontend: { usePermission() {}, usePluginApi() { return api; }, useTranslation() { return { t }; } },
    ui: { PanelShell() {} },
    sonner: { toast: { success(text) { toasts.push(text); }, error(text) { toasts.push(`error: ${text}`); } } },
  };
  globalThis.confirm = () => true;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  delete globalThis.__pveMocks;
  await module.activate({
    hasPermission: async () => false,
    registerRailItem() {}, registerTab(type, component) { if (type.endsWith("-connect")) wakeTab = component; }, registerHostAction(value) { actions[value.id] = value; },
    api, t,
  });
  const action = actions["pve-power.connect"];
  assert.equal(action.when({ id: 74, enableSsh: true }), true);
  assert.equal(action.when({ id: 62, enableSsh: true }), false);
  assert.equal(action.tabType, "pve-power-connect");
  assert.equal(action.run, undefined);
  let wakeEffects = renderWake({ tab: { id: "wake-74" }, host: { id: 74, enableSsh: true }, isFocusedPane: true, shell: {
    openTab(_host, type) { calls.push(type); },
    closeTab(id) { calls.push(id); },
  } });
  wakeEffects[0]();
  await handoff;
  wakeEffects = renderWake({ tab: { id: "wake-74" }, host: { id: 74, enableSsh: true }, isFocusedPane: true, shell: {
    openTab(_host, type) { calls.push(type); },
    closeTab(id) { calls.push(id); },
  } });
  wakeEffects[1]();
  assert.equal(calls.includes("wake-74"), false);
  wakeEffects = renderWake({ tab: { id: "wake-74" }, host: { id: 74, enableSsh: true }, isFocusedPane: false, shell: {
    openTab(_host, type) { calls.push(type); },
    closeTab(id) { calls.push(id); },
  } });
  wakeEffects[1]();
  assert.equal(calls[0][0], "/start");
  assert.equal(calls[0][1].connectionHostId, 74);
  assert.equal(calls[0][1].allowRunning, true);
  assert.equal(calls[1][0], "/ssh-ready");
  assert.equal(calls[1][1].key, "62:lxc:pve:104");
  assert.equal(calls[2], "terminal");
  assert.equal(calls[3], "wake-74");
  hookState = [];
  handoff = new Promise(resolve => { resolveHandoff = resolve; });
  wakeEffects = renderWake({ tab: { id: "wake-75" }, host: { id: 75, enableSsh: true }, isFocusedPane: true, shell: {
    openTab(_host, type) { calls.push(type); },
    closeTab(id) { calls.push(id); },
  } });
  wakeEffects[0]();
  await handoff;
  wakeEffects = renderWake({ tab: { id: "wake-75" }, host: { id: 75, enableSsh: true }, isFocusedPane: false, shell: {
    openTab(_host, type) { calls.push(type); },
    closeTab(id) { calls.push(id); },
  } });
  wakeEffects[1]();
  assert.equal(calls.at(-1), "wake-75");
  assert.equal(calls.filter(call => Array.isArray(call)).length, 2);

  const terminals = calls.filter(call => call === "terminal").length;
  await actions["pve-power.start"].run({ id: 74 });
  assert.equal(calls.at(-1)[0], "/start");
  assert.equal(calls.at(-1)[1].allowRunning, true);
  assert.equal(calls.filter(call => call === "terminal").length, terminals);
  assert.equal(toasts.at(-1), "Started CT 104");

  const shutdown = actions["pve-power.shutdown"];
  await shutdown.run({ id: 74, name: "Postiz" });
  assert.equal(shutdown.when({ id: 74 }), true);
  assert.equal(shutdown.when({ id: 75 }), false);
  assert.equal(calls.at(-1)[0], "/stop");
  assert.equal(calls.at(-1)[1].key, "62:lxc:pve:104");
  assert.equal(toasts.at(-1), "Graceful shutdown requested for CT 104");
});
