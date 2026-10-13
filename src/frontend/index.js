import "./styles.css";
import React, { useEffect, useState } from "react";
import { usePermission, usePluginApi, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { PanelShell } from "@termix-ssh/plugin-sdk/ui";
import { toast } from "sonner";

const h = React.createElement;
// 24px line icons, 2px round strokes, so they sit next to the host's own icons.
const icon = (...paths) => props => h("svg", { ...props, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
  ...paths.map(d => h("path", { key: d, d })));
const Power = icon("M12 2v10", "M18.36 6.64a9 9 0 1 1-12.72 0");
const Stop = icon("M5 5h14v14H5z");
const Play = icon("m5 3 14 9-14 9V3z");
const PlugZap = icon("M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v4a6 6 0 0 1-12 0V8z", "m14 14-2 3h4l-2 3");
const guestLabel = (t, { type, vmid }) => t(type === "lxc" ? "guest.lxc" : "guest.qemu", { vmid });

function WakeTab({ tab, host, shell, isFocusedPane }) {
  const { t } = useTranslation();
  const api = usePluginApi();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [handoff, setHandoff] = useState(false);
  useEffect(() => {
    if (!host) return;
    let active = true;
    (async () => {
      const { data } = await api.get("/vm").catch(error => {
        if (error.response?.status === 403) return { data: { guests: [] } };
        throw error;
      });
      const guest = data.guests?.find(item => item.config.connectionHostId === Number(host.id));
      if (guest) {
        const { data: started } = await api.post("/start", { ...guest.config, allowRunning: true });
        // A freshly started guest needs time for its SSH service; open the terminal anyway after ~2 minutes.
        if (started?.guests?.find(item => item.key === guest.key)?.last?.status === "starting") {
          if (active) setWaiting(true);
          for (let i = 0; i < 12 && active; i++) {
            const { data: check } = await api.post("/ssh-ready", { key: guest.key }).catch(() => ({ data: {} }));
            if (check?.ready) break;
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      if (active) {
        shell.openTab(host, "terminal");
        setHandoff(true);
      }
    })().catch(cause => { if (active) setError(cause.response?.data?.error || cause.message); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (handoff && !isFocusedPane) shell.closeTab(tab.id);
  }, [handoff, isFocusedPane]);
  return h("div", { className: "pve-page" },
    h("h2", null, t(error ? "wake.failed" : waiting ? "wake.waiting" : "wake.connecting")),
    error && h("p", { role: "alert" }, error),
    error && h("button", { type: "button", className: "pve-button border", onClick: () => { setError(""); setAttempt(attempt + 1); } }, t("wake.retry")));
}

function VmTab() {
  const { t } = useTranslation();
  const api = usePluginApi();
  const canManage = usePermission("manage");
  const [vm, setVm] = useState({ guests: [] });
  const [form, setForm] = useState({ hostId: "", node: "", vmid: "", type: "qemu", connectionHostId: "", idleCpuPercent: "5", maxUptimeMinutes: "120" });
  const [hosts, setHosts] = useState([]);
  const [vms, setVms] = useState([]);
  const [guestNames, setGuestNames] = useState({});
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function load() {
    const { data } = await api.get("/vm");
    setVm(data);
  }

  async function refresh() {
    const { data } = await api.post("/refresh");
    setVm(data);
  }

  useEffect(() => {
    load().then(() => { if (canManage) return refresh(); }).catch(error => setMessage(error.response?.data?.error || error.message));
    api.get("/hosts").then(({ data }) => setHosts(data)).catch(error => setMessage(error.response?.data?.error || error.message));
    const timer = setInterval(() => load().catch(() => {}), 15_000);
    const refreshTimer = canManage && setInterval(() => refresh().catch(() => {}), 60_000);
    return () => { clearInterval(timer); clearInterval(refreshTimer); };
  }, []);

  useEffect(() => {
    if (!form.hostId) { setVms([]); return; }
    let active = true;
    setVms([]);
    api.get(`/vms?hostId=${encodeURIComponent(form.hostId)}`)
      .then(({ data }) => { if (active) setVms(data); })
      .catch(error => { if (active) setMessage(error.response?.data?.error || error.message); });
    return () => { active = false; };
  }, [form.hostId]);

  const savedHosts = [...new Set((vm.guests || []).map(guest => guest.config.hostId))].join(",");
  useEffect(() => {
    if (!savedHosts) { setGuestNames({}); return; }
    let active = true;
    Promise.all(savedHosts.split(",").map(async hostId => {
      try {
        const { data } = await api.get(`/vms?hostId=${encodeURIComponent(hostId)}`);
        return data.map(item => [`${hostId}:${item.type}:${item.node}:${item.vmid}`, item.name]);
      } catch { return []; }
    })).then(groups => { if (active) setGuestNames(Object.fromEntries(groups.flat())); });
    return () => { active = false; };
  }, [savedHosts]);

  async function send(path, body) {
    setWorking(true);
    setMessage("");
    try {
      const { data } = await api.post(path, body);
      setVm(data);
      if (path === "/config") await refresh();
    } catch (error) {
      setMessage(error.response?.data?.error || error.message);
    } finally {
      setWorking(false);
    }
  }

  function monitor(guest) {
    const uptime = Math.floor((guest.last?.uptime || 0) / 60);
    const limit = guest.config.maxUptimeMinutes;
    if (globalThis.confirm(t(limit ? "confirm.monitorLimit" : "confirm.monitor", { minutes: uptime, limit }))) {
      send("/adopt", { key: guest.key });
    }
  }

  function stop(guest) {
    if (globalThis.confirm(t("confirm.stop", { guest: guestLabel(t, guest.config) }))) {
      send("/stop", { key: guest.key });
    }
  }

  function configBody() {
    return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, key === "node" || key === "type" ? value.trim() : key === "connectionHostId" && !value ? null : Number(value)]));
  }

  const fields = [
    ["idleCpuPercent", t("setup.idleCpu")],
    ["maxUptimeMinutes", t("setup.maxUptime")],
  ];
  const guests = vm.guests || [];
  const backendOutdated = vm.guests === undefined;
  const selectedKey = `${form.hostId}:${form.type}:${form.node}:${form.vmid}`;
  const selectedGuest = guests.find(guest => guest.key === selectedKey);
  const control = "pve-control border bg-background";
  const button = "pve-button border";
  return h(PanelShell, { icon: h(Power, { className: "size-4" }), title: t("tab.title") },
    h("div", { className: "pve-page" },
      h("p", { className: "pve-intro" }, t("tab.intro")),
      h("details", { className: "pve-panel" },
        h("summary", { className: "cursor-pointer font-semibold" }, t("webhooks.title")),
        h("div", { className: "mt-3 space-y-3 text-sm" },
          h("p", null, t("webhooks.auth")),
          h("p", null, t("webhooks.routes")),
          h("p", null, t("webhooks.headers")))),
      backendOutdated && h("p", { role: "alert", className: "rounded-md border p-3 text-sm" }, t("tab.outdated")),
      h("div", { className: "pve-layout" },
        canManage && !backendOutdated && h("section", { className: "pve-panel" },
          h("div", { className: "pve-section-head" },
            h("h2", null, t("setup.title")),
            h("p", null, t("setup.description"))),
          h("form", { className: "pve-form", onSubmit: event => {
            event.preventDefault();
            send("/config", configBody());
          } },
            h("label", { className: "pve-field" },
              h("span", null, t("setup.proxmoxHost")),
              h("select", { className: control, required: true,
                value: form.hostId, disabled: working,
                onChange: event => setForm({ ...form, hostId: event.target.value, node: "", vmid: "", type: "qemu", connectionHostId: "" }) },
                h("option", { value: "" }, t("setup.selectHost")),
                ...hosts.filter(host => host.proxmox).map(host => h("option", { key: host.id, value: host.id }, t("setup.hostOption", { name: host.name, id: host.id })))
              )
            ),
            h("label", { className: "pve-field" },
              h("span", null, t("setup.guest")),
              h("select", { className: control, required: true,
                value: form.vmid ? `${form.type}/${form.node}/${form.vmid}` : "", disabled: working || !form.hostId,
                onChange: event => {
                  const selected = vms.find(item => `${item.type}/${item.node}/${item.vmid}` === event.target.value);
                  setForm({ ...form, type: selected?.type || "qemu", node: selected?.node || "", vmid: selected ? String(selected.vmid) : "", connectionHostId: "" });
                } },
                h("option", { value: "" }, t(form.hostId && !vms.length ? "setup.noGuests" : "setup.selectGuest")),
                ...vms.map(item => h("option", { key: `${item.type}/${item.node}/${item.vmid}`, value: `${item.type}/${item.node}/${item.vmid}` },
                  t("setup.guestOption", { name: item.name, guest: guestLabel(t, item), node: item.node })))
              )
            ),
            h("label", { className: "pve-field" },
              h("span", null, t("setup.connectionHost")),
              h("select", { className: control, value: form.connectionHostId, disabled: working,
                onChange: event => setForm({ ...form, connectionHostId: event.target.value }) },
                h("option", { value: "" }, t("setup.noAutoStart")),
                ...hosts.filter(host => String(host.id) !== form.hostId).map(host => h("option", { key: host.id, value: host.id }, t("setup.hostOption", { name: host.name, id: host.id })))
              ),
              h("small", null, t("setup.connectionHelp"))),
            h("div", { className: "pve-field-grid" }, ...fields.map(([key, label]) => h("label", { key, className: "pve-field" },
              h("span", null, label),
              h("input", { className: control, type: "number", min: 0, max: key === "idleCpuPercent" ? 100 : undefined,
                required: true, value: form[key], disabled: working || Boolean(selectedGuest?.armed),
                onChange: event => setForm({ ...form, [key]: event.target.value }) })
            ))),
            h("div", { className: "pve-actions" },
              h("button", { type: "submit", className: `${button} pve-button-primary bg-primary text-primary-foreground`, disabled: working || Boolean(selectedGuest?.armed) }, t("setup.save")),
              h("button", { type: "button", className: button, disabled: working || Boolean(selectedGuest?.armed) || selectedGuest?.last?.status === "stopping" || !form.hostId || !form.vmid,
                onClick: () => selectedGuest?.last?.status === "running" ? monitor(selectedGuest) : send("/start", configBody()) },
                t(selectedGuest?.last?.status === "running" ? "setup.monitor" : "setup.start"))
            )
          )
        ),
        h("section", { className: "pve-guest-list" },
          h("div", { className: "pve-list-head" },
            h("h2", null, t("guests.title")),
            h("span", null, t("guests.configured", { count: guests.length }))),
          !guests.length && !backendOutdated && h("div", { className: "pve-panel pve-empty" }, t("guests.empty")),
          ...guests.map(guest => {
            const stopping = Boolean(guest.armed?.shutdownRequestedAt || guest.last?.stopRequestedAt || guest.last?.status === "stopping");
            const running = guest.last?.status === "running" || stopping;
            const statusLabel = t(`status.${stopping ? "stopping" : guest.last?.status || "checking"}`);
            const uptimeSeconds = Number.isFinite(guest.last?.uptime) && Number.isFinite(guest.last?.checkedAt)
              ? guest.last.uptime + Math.max(0, Math.floor((now - guest.last.checkedAt) / 1000)) : null;
            const remaining = guest.armed && running && !stopping && guest.config.maxUptimeMinutes > 0 && uptimeSeconds !== null
              ? Math.max(0, guest.config.maxUptimeMinutes * 60 - uptimeSeconds) : null;
            const countdown = remaining === null ? null : `${Math.floor(remaining / 3600)}:${String(Math.floor(remaining % 3600 / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
            const guestId = guestLabel(t, guest.config);
            return h("article", { key: guest.key, className: "pve-guest-card" },
              h("div", { className: "pve-guest-head" },
                h("div", null,
                  h("h3", null, guestNames[guest.key] || guestId),
                  h("p", null, `${guestNames[guest.key] ? `${guestId} · ` : ""}${guest.config.node} · ${hosts.find(host => host.id === guest.config.hostId)?.name || t("guests.host", { id: guest.config.hostId })}`)),
                h("span", { className: `pve-status ${stopping ? "pve-status-stopping" : running ? "pve-status-running" : ""}` }, statusLabel)
              ),
              guest.config.connectionHostId && h("p", { className: "pve-idle-progress" }, t("guests.startsOnConnect", { host: hosts.find(host => host.id === guest.config.connectionHostId)?.name || t("guests.connectionHost", { id: guest.config.connectionHostId }) })),
              running && guest.last?.cpuPercent != null && h("div", { className: "pve-metrics" },
                h("span", null, t("guests.cpu", { percent: guest.last.cpuPercent })),
                h("span", null, t("guests.uptime", { minutes: Math.floor((uptimeSeconds ?? guest.last.uptime) / 60) }))),
              countdown && h("div", { className: "pve-countdown", role: "timer", "aria-live": "off" },
                h("span", null, t("guests.countdown")),
                h("strong", null, countdown),
                remaining === 0 && h("small", null, t("guests.limitReached")),
                remaining > 0 && guest.config.idleCpuPercent > 0 && h("small", null, t("guests.lowCpuSooner"))),
              guest.armed && !stopping && guest.config.idleCpuPercent > 0 && h("p", { className: "pve-idle-progress" }, t("guests.idleChecks", { count: guest.armed.idleSamples })),
              guest.last?.error && h("p", { role: "alert", className: "mt-3 text-sm text-destructive" }, t("guests.checkFailed", { error: guest.last.error })),
              stopping && h("p", { className: "mt-3 text-sm text-muted-foreground" }, t("guests.stopRequested")),
              h("p", { className: "mt-3 text-sm text-muted-foreground" }, t(guest.armed ? "guests.armed" : "guests.off")),
              canManage && h("div", { className: "pve-actions pve-guest-actions" },
                !guest.armed && !stopping && h("button", { type: "button", className: button, disabled: working, onClick: () => running ? monitor(guest) : send("/start", guest.config) }, t(running ? "actions.monitor" : "actions.start")),
                running && !stopping && h("button", { type: "button", className: button, disabled: working, onClick: () => stop(guest) }, t("actions.stop")),
                h("button", { type: "button", className: button, disabled: working, onClick: () => setForm(Object.fromEntries(Object.entries(guest.config).map(([key, value]) => [key, value == null ? "" : String(value)]))) }, t("actions.edit")),
                guest.armed && h("button", { type: "button", className: button, disabled: working, onClick: () => send("/disarm", { key: guest.key }) }, t("actions.disarm")),
                !guest.armed && h("button", { type: "button", className: button, disabled: working, onClick: () => send("/remove", { key: guest.key }) }, t("actions.remove"))
              )
            );
          })
        )
      ),
      message && h("p", { role: "alert", className: "rounded-md border p-3 text-sm text-destructive" }, message)
    )
  );
}

export async function activate(app) {
  app.registerRailItem({ id: "pve-power", icon: Power, titleKey: "tab.title", kind: "tab", permission: "use" });
  app.registerTab("pve-power", VmTab, { icon: Power, titleKey: "tab.title", singleton: true, hostless: true });
  app.registerTab("pve-power-connect", WakeTab, { icon: PlugZap, titleKey: "hostAction.title", persistent: false, requiresHost: true });

  // Host action `when` must be synchronous, so keep a cached copy of the linked hosts.
  let links = new Map();
  let fetchedAt = 0;
  function loadLinks() {
    fetchedAt = Date.now();
    return app.api.get("/vm").then(({ data }) => {
      const next = new Map((data.guests || []).filter(guest => guest.config.connectionHostId).map(guest => [guest.config.connectionHostId, guest]));
      const changed = [...next.keys()].join() !== [...links.keys()].join();
      links = next;
      // The host list only re-evaluates `when` when it re-renders, so ask it to reload.
      // The SDK has no host-action invalidation API; this is the event Termix's own host list listens for.
      if (changed) globalThis.dispatchEvent?.(new CustomEvent("termix:hosts-changed"));
    }).catch(() => { fetchedAt = Date.now() - 25_000; });
  }
  loadLinks();
  const linked = host => {
    if (Date.now() - fetchedAt > 30_000) loadLinks();
    return links.has(Number(host.id));
  };
  app.registerHostAction({
    id: "pve-power.connect", titleKey: "hostAction.title", icon: PlugZap,
    kind: "open", order: 11, tabType: "pve-power-connect",
    when: host => Boolean(host.enableSsh) && linked(host),
  });
  app.registerHostAction({
    id: "pve-power.start", titleKey: "hostAction.start", icon: Play, kind: "open", order: 12, when: linked,
    run: async host => {
      await loadLinks();
      const guest = links.get(Number(host.id));
      if (!guest) return toast.error(app.t("toast.notLinked"));
      const name = guestLabel(app.t, guest.config);
      try {
        const { data } = await app.api.post("/start", { ...guest.config, allowRunning: true });
        const started = data?.guests?.find(item => item.key === guest.key)?.last?.status === "starting";
        toast.success(app.t(started ? "toast.started" : "toast.alreadyRunning", { guest: name }));
      } catch (error) {
        toast.error(error.response?.data?.error || error.message);
      }
    },
  });
  app.registerHostAction({
    id: "pve-power.shutdown", titleKey: "hostAction.shutdown", icon: Stop, kind: "open", order: 13, when: linked,
    run: async host => {
      await loadLinks();
      const guest = links.get(Number(host.id));
      if (!guest) return toast.error(app.t("toast.notLinked"));
      const name = guestLabel(app.t, guest.config);
      if (!globalThis.confirm(app.t("confirm.hostStop", { guest: name, host: host.name || app.t("confirm.thisHost") }))) return;
      try {
        await app.api.post("/stop", { key: guest.key });
        toast.success(app.t("toast.stopRequested", { guest: name }));
      } catch (error) {
        toast.error(error.response?.data?.error || error.message);
      }
    },
  });
}
