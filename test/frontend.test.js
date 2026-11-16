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
  keys.push("status.checking", "status.starting", "status.running", "status.stopped", "status.stopping", "status.restarting");
  assert.ok(keys.length > 40);
  for (const key of keys) assert.equal(typeof (lookup(key) ?? lookup(`${key}_one`)), "string", `missing locale key ${key}`);
});

test("host actions and mobile controls use the saved guest link", async () => {
  const calls = [];
  const actions = {};
  const slots = {};
  const toasts = [];
  let wakeTab;
  let mainTab;
  let controlsTab;
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
  const React = { createElement(type, props, ...children) { return { type, props, children }; }, useEffect(fn) { effects.push(fn); }, useState(initial) {
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
    .replace('import { usePermission, usePluginApi, useSettings, useTranslation } from "@termix-ssh/plugin-sdk/frontend";', 'const { usePermission, usePluginApi, useSettings, useTranslation } = globalThis.__pveMocks.frontend;')
    .replace('import { ListBadge, PanelShell } from "@termix-ssh/plugin-sdk/ui";', 'const { ListBadge, PanelShell } = globalThis.__pveMocks.ui;')
    .replace('import { toast } from "sonner";', 'const { toast } = globalThis.__pveMocks.sonner;');
  globalThis.__pveMocks = {
    React,
    frontend: { usePermission() { return true; }, usePluginApi() { return api; }, useSettings() { return { values: { showStart: false }, loaded: true, save: async values => { calls.push(["settings", values]); } }; }, useTranslation() { return { t }; } },
    ui: { ListBadge() {}, PanelShell() {} },
    sonner: { toast: { success(text) { toasts.push(text); }, info(text) { toasts.push(text); }, error(text) { toasts.push(`error: ${text}`); } } },
  };
  globalThis.confirm = () => true;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  delete globalThis.__pveMocks;
  const pool = [{ id: 26, ip: "Tiny-Debian301.home" }, { id: 28, ip: "pve.home" }, { id: 13, ip: "10.0.0.1" }, { id: 14, ip: "10.0.0.1" }];
  assert.equal(module.matchHost(pool, [], "28", { name: "tiny-debian301.home" }), "26");
  assert.equal(module.matchHost(pool, [], "28", { name: "10.0.0.1" }), "", "ambiguous address");
  assert.equal(module.matchHost(pool, [], "28", { name: "pve.home" }), "", "the Proxmox host itself");
  assert.equal(module.matchHost(pool, [{ config: { connectionHostId: 26 } }], "28", { name: "tiny-debian301.home" }), "", "already linked");
  assert.equal(module.matchHost(pool, [], "28", undefined), "");
  const listeners = {};
  globalThis.addEventListener = (type, fn) => { listeners[type] = fn; };
  await module.activate({
    hasPermission: async () => false,
    registerRailItem() {}, registerTab(type, component) { if (type === "pve-power") mainTab = component; if (type.endsWith("-connect")) wakeTab = component; if (type === "Proxmox-Power-Controls") controlsTab = component; }, registerHostAction(value) { actions[value.id] = value; },
    registerSlotContribution(id, value) { slots[id] = value; },
    api, t,
  });
  delete globalThis.addEventListener;
  const action = actions["pve-power.connect.lxc"];
  assert.equal(action.when({ id: 74, enableSsh: true }), true);
  assert.equal(action.when({ id: 62, enableSsh: true }), false);
  assert.equal(t(actions["pve-power.controls"].titleKey), "PVE Power");
  assert.equal(actions["pve-power.controls"].tabType, "Proxmox-Power-Controls");
  assert.equal(actions["pve-power.controls"].when({ id: 74 }), true);
  assert.equal(t(action.titleKey), "Start LXC + SSH");
  assert.equal(t(actions["pve-power.start.lxc"].titleKey), "Start LXC");
  assert.equal(t(actions["pve-power.shutdown.lxc"].titleKey), "Stop LXC");
  const tile = slots["host-page.tiles"];
  assert.equal(tile.actionId, "pve-power.controls");
  assert.equal(tile.when({ host: { id: 74 } }), true);
  assert.equal(tile.when({ host: { id: 62 } }), false);
  const savedGet = api.get;
  api.get = async () => ({ data: { guests: [{ key: "62:lxc:pve:105", config: { connectionHostId: 62 } }] } });
  await listeners["pve-power:links-changed"]();
  assert.equal(tile.when({ host: { id: 62 } }), true, "a save refreshes the link cache at once");
  // Per-user switches hide single actions; the other guest type's action never shows.
  api.get = async () => ({ data: { ...(await savedGet()).data, actions: { showStart: false } } });
  await listeners["pve-power:links-changed"]();
  assert.equal(actions["pve-power.start.lxc"].when({ id: 74 }), false);
  assert.equal(actions["pve-power.shutdown.lxc"].when({ id: 74 }), true);
  assert.equal(actions["pve-power.shutdown.qemu"].when({ id: 74 }), false);
  assert.equal(t(actions["pve-power.shutdown.qemu"].titleKey), "Stop VM");
  api.get = savedGet;
  await listeners["pve-power:links-changed"]();
  assert.equal(tile.when({ host: { id: 62 } }), false);
  const tileView = tile.component({ host: { id: 74 }, isVisible: true });
  assert.equal(tileView.type, controlsTab);
  assert.equal(tileView.props.tile, true);
  assert.equal(action.tabType, undefined);
  action.run({ id: 74 }, { openTab(_host, type) { calls.push(type); } });
  assert.equal(calls.pop(), "pve-power-connect");
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
  await actions["pve-power.start.lxc"].run({ id: 74 });
  assert.equal(calls.at(-1)[0], "/start");
  assert.equal(calls.at(-1)[1].allowRunning, true);
  assert.equal(calls.filter(call => call === "terminal").length, terminals);
  assert.equal(toasts.at(-1), "Started CT 104");

  const shutdown = actions["pve-power.shutdown.lxc"];
  await shutdown.run({ id: 74, name: "Postiz" });
  assert.equal(shutdown.when({ id: 74 }), true);
  assert.equal(shutdown.when({ id: 75 }), false);
  assert.equal(calls.at(-1)[0], "/stop");
  assert.equal(calls.at(-1)[1].key, "62:lxc:pve:104");
  assert.equal(toasts.at(-1), "Graceful shutdown requested for CT 104");

  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.contributes.mobile.views.includes("Proxmox-Power-Controls"));
  assert.ok(manifest.contributes.tabs.some(tab => tab.id === "Proxmox-Power-Controls" && tab.openFrom.includes("host-context-menu")));
  api.get = async path => {
    calls.push([path]);
    return { data: { guests: [{ key: "62:lxc:pve:104", config: { hostId: 62, type: "lxc", vmid: 104, connectionHostId: 74 }, last: { status: "running" } }] } };
  };
  api.post = async (path, body) => {
    calls.push([path, body]);
    return { data: { guests: [{ key: "62:lxc:pve:104", config: { hostId: 62, type: "lxc", vmid: 104, connectionHostId: 74 }, last: { status: path === "/refresh" ? "stopped" : path === "/start" ? "running" : path === "/restart" ? "restarting" : "stopping" } }] } };
  };
  // Main tab: an unlinked saved guest offers a one-click link, and the dropdown hides hosts linked elsewhere.
  const unlinked = { key: "28:lxc:pve:301", config: { hostId: 28, node: "pve", type: "lxc", vmid: 301, connectionHostId: null } };
  const other = { key: "28:lxc:pve:104", config: { hostId: 28, node: "pve", type: "lxc", vmid: 104, connectionHostId: 39 } };
  hookState = [{ guests: [unlinked, other] }, { hostId: "28", node: "", vmid: "", type: "qemu", connectionHostId: "", idleCpuPercent: "5", maxUptimeMinutes: "120" },
    [{ id: 26, name: "Debian301", ip: "tiny-debian301.home" }, { id: 28, name: "Tiny PVE", ip: "pve.home" }, { id: 39, name: "Postiz", ip: "postiz.home" }],
    [], { "28:lxc:pve:301": "tiny-debian301.home" }];
  hookIndex = 0; effects = [];
  const main = mainTab();
  const flat = node => node && typeof node === "object" ? [node, ...node.children.flatMap(flat)] : [node];
  const nodes = flat(main);
  await nodes.find(node => node?.type === "button" && node.children.includes("Link to Debian301")).props.onClick();
  assert.deepEqual(calls.find(call => call[0] === "/config"), ["/config", { ...unlinked.config, connectionHostId: 26 }]);
  assert.deepEqual(nodes.filter(node => node?.type === "option" && node.props.value !== "" && typeof node.props.value === "number").map(node => node.children[0]), ["Debian301 · tiny-debian301.home"]);
  const boxes = nodes.filter(node => node?.type === "input" && node.props.type === "checkbox");
  assert.deepEqual(boxes.map(box => box.props.checked), [true, true, false, true]);
  await boxes[3].props.onChange({ target: { checked: false } });
  assert.deepEqual(calls.at(-1), ["settings", { showStart: false, showStop: false }]);
  hookState = [];
  const editor = { editHost(id) { calls.push(["editHost", id]); }, openHostEditor() { calls.push(["openHostEditor"]); } };
  const renderControls = () => { hookIndex = 0; effects = []; return controlsTab({ host: { id: 74, name: "Postiz" }, shell: editor }); };
  const buttons = node => node && typeof node === "object" ? [node.type === "button" ? node : null, ...node.children.flatMap(buttons)].filter(Boolean) : [];
  const button = label => buttons(renderControls()).find(item => item.children.includes(label));
  renderControls();
  effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.at(-2), ["/vm"]);
  assert.deepEqual(calls.at(-1), ["/refresh", { key: "62:lxc:pve:104" }]);
  assert.ok(button("Edit host"));
  button("Edit host").props.onClick();
  assert.deepEqual(calls.at(-1), ["editHost", 74]);
  editor.editHost = undefined;
  button("Edit host").props.onClick();
  assert.deepEqual(calls.at(-1), ["openHostEditor"]);
  assert.equal(toasts.at(-1), "Select Postiz in Hosts to edit it.");
  await button("Start").props.onClick();
  assert.equal(calls.at(-1)[0], "/start");
  assert.equal(calls.at(-1)[1].connectionHostId, 74);
  await button("Stop").props.onClick();
  assert.equal(calls.at(-1)[0], "/stop");
  assert.equal(calls.at(-1)[1].key, "62:lxc:pve:104");
  hookState[0].last.status = "running";
  await button("Restart").props.onClick();
  assert.equal(calls.at(-1)[0], "/restart");
  assert.equal(calls.at(-1)[1].key, "62:lxc:pve:104");
  assert.equal(toasts.at(-1), "Restart requested for CT 104");
  hookIndex = 0;
  const tiled = controlsTab({ host: { id: 74, name: "Postiz" }, tile: true });
  assert.equal(tiled.type, "section");
  assert.equal(buttons(tiled).some(item => item.children.includes("Edit host")), false);
});
