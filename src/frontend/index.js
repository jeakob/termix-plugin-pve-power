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

function WakeTab({ tab, host, shell, isFocusedPane }) {
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
    h("h2", null, error ? "Could not connect" : waiting ? "Guest started, waiting for SSH…" : "Checking guest and connecting…"),
    error && h("p", { role: "alert" }, error),
    error && h("button", { type: "button", className: "pve-button border", onClick: () => { setError(""); setAttempt(attempt + 1); } }, "Retry"));
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
    const limit = guest.config.maxUptimeMinutes ? ` The ${guest.config.maxUptimeMinutes}-minute limit may request shutdown on the next check.` : "";
    if (globalThis.confirm(`Monitor this running guest? Its current uptime is about ${uptime} minutes.${limit}`)) {
      send("/adopt", { key: guest.key });
    }
  }

  function stop(guest) {
    const name = `${guest.config.type === "lxc" ? "CT" : "VM"} ${guest.config.vmid}`;
    if (globalThis.confirm(`Request a graceful shutdown for ${name}? Work in the guest may be interrupted.`)) {
      send("/stop", { key: guest.key });
    }
  }

  function configBody() {
    return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, key === "node" || key === "type" ? value.trim() : key === "connectionHostId" && !value ? null : Number(value)]));
  }

  const fields = [
    ["idleCpuPercent", "Idle CPU threshold (%) · 0 disables"],
    ["maxUptimeMinutes", "Maximum guest uptime (minutes) · 0 disables"],
  ];
  const guests = vm.guests || [];
  const backendOutdated = vm.guests === undefined;
  const selectedKey = `${form.hostId}:${form.type}:${form.node}:${form.vmid}`;
  const selectedGuest = guests.find(guest => guest.key === selectedKey);
  const control = "pve-control border bg-background";
  const button = "pve-button border";
  return h(PanelShell, { icon: h(Power, { className: "size-4" }), title: t("tab.title") },
    h("div", { className: "pve-page" },
      h("p", { className: "pve-intro" }, "Start a saved VM or container, or monitor one already running. Automatic shutdown uses five low CPU checks after 10 minutes, or the uptime limit you set."),
      h("details", { className: "pve-panel" },
        h("summary", { className: "cursor-pointer font-semibold" }, "Webhook integrations"),
        h("div", { className: "mt-3 space-y-3 text-sm" },
          h("p", null, "Automation services can control guests through the authenticated Termix API. Create a Termix API key for a user with Proxmox Power manage permission, then configure your service to send JSON POST requests."),
          h("p", null, "Start a guest: POST /plugin-api/pve-power/start with that guest’s config from GET /plugin-api/pve-power/vm. Stop a guest gracefully: POST /plugin-api/pve-power/stop with { \"key\": \"<guest key>\" } from the same response."),
          h("p", null, "Send Authorization: Bearer <Termix API key> and Content-Type: application/json. These routes require Termix authentication; this plugin does not expose a public unauthenticated webhook URL."))),
      backendOutdated && h("p", { role: "alert", className: "rounded-md border p-3 text-sm" }, "Termix is still running an older plugin backend. Restart the Termix server to load this update."),
      h("div", { className: "pve-layout" },
        canManage && !backendOutdated && h("section", { className: "pve-panel" },
          h("div", { className: "pve-section-head" },
            h("h2", null, "Guest setup"),
            h("p", null, "Choose a Proxmox guest and its shutdown rules.")),
          h("form", { className: "pve-form", onSubmit: event => {
            event.preventDefault();
            send("/config", configBody());
          } },
            h("label", { className: "pve-field" },
              h("span", null, "Termix Proxmox host"),
              h("select", { className: control, required: true,
                value: form.hostId, disabled: working,
                onChange: event => setForm({ ...form, hostId: event.target.value, node: "", vmid: "", type: "qemu", connectionHostId: "" }) },
                h("option", { value: "" }, "Select a host"),
                ...hosts.filter(host => host.proxmox).map(host => h("option", { key: host.id, value: host.id }, `${host.name} (ID ${host.id})`))
              )
            ),
            h("label", { className: "pve-field" },
              h("span", null, "VM or LXC container"),
              h("select", { className: control, required: true,
                value: form.vmid ? `${form.type}/${form.node}/${form.vmid}` : "", disabled: working || !form.hostId,
                onChange: event => {
                  const selected = vms.find(item => `${item.type}/${item.node}/${item.vmid}` === event.target.value);
                  setForm({ ...form, type: selected?.type || "qemu", node: selected?.node || "", vmid: selected ? String(selected.vmid) : "", connectionHostId: "" });
                } },
                h("option", { value: "" }, form.hostId && !vms.length ? "No guests found" : "Select a guest"),
                ...vms.map(item => h("option", { key: `${item.type}/${item.node}/${item.vmid}`, value: `${item.type}/${item.node}/${item.vmid}` },
                  `${item.name} (${item.type === "lxc" ? "CT" : "VM"} ${item.vmid}, ${item.node})`))
              )
            ),
            h("label", { className: "pve-field" },
              h("span", null, "Termix connection host · optional"),
              h("select", { className: control, value: form.connectionHostId, disabled: working,
                onChange: event => setForm({ ...form, connectionHostId: event.target.value }) },
                h("option", { value: "" }, "No automatic start on connect"),
                ...hosts.filter(host => String(host.id) !== form.hostId).map(host => h("option", { key: host.id, value: host.id }, `${host.name} (ID ${host.id})`))
              ),
              h("small", null, "Connecting to this SSH host starts the selected guest if it is stopped.")),
            h("div", { className: "pve-field-grid" }, ...fields.map(([key, label]) => h("label", { key, className: "pve-field" },
              h("span", null, label),
              h("input", { className: control, type: "number", min: 0, max: key === "idleCpuPercent" ? 100 : undefined,
                required: true, value: form[key], disabled: working || Boolean(selectedGuest?.armed),
                onChange: event => setForm({ ...form, [key]: event.target.value }) })
            ))),
            h("div", { className: "pve-actions" },
              h("button", { type: "submit", className: `${button} pve-button-primary bg-primary text-primary-foreground`, disabled: working || Boolean(selectedGuest?.armed) }, "Save guest"),
              h("button", { type: "button", className: button, disabled: working || Boolean(selectedGuest?.armed) || selectedGuest?.last?.status === "stopping" || !form.hostId || !form.vmid,
                onClick: () => selectedGuest?.last?.status === "running" ? monitor(selectedGuest) : send("/start", configBody()) },
                selectedGuest?.last?.status === "running" ? "Monitor selected guest" : "Start selected guest")
            )
          )
        ),
        h("section", { className: "pve-guest-list" },
          h("div", { className: "pve-list-head" },
            h("h2", null, "Saved guests"),
            h("span", null, `${guests.length} configured`)),
          !guests.length && !backendOutdated && h("div", { className: "pve-panel pve-empty" }, "No guests saved yet. Choose a host and guest to get started."),
          ...guests.map(guest => {
            const stopping = Boolean(guest.armed?.shutdownRequestedAt || guest.last?.stopRequestedAt || guest.last?.status === "stopping");
            const running = guest.last?.status === "running" || stopping;
            const statusLabel = stopping ? "Shutting down" : guest.last?.status || "Checking status";
            const uptimeSeconds = Number.isFinite(guest.last?.uptime) && Number.isFinite(guest.last?.checkedAt)
              ? guest.last.uptime + Math.max(0, Math.floor((now - guest.last.checkedAt) / 1000)) : null;
            const remaining = guest.armed && running && !stopping && guest.config.maxUptimeMinutes > 0 && uptimeSeconds !== null
              ? Math.max(0, guest.config.maxUptimeMinutes * 60 - uptimeSeconds) : null;
            const countdown = remaining === null ? null : `${Math.floor(remaining / 3600)}:${String(Math.floor(remaining % 3600 / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
            const guestId = `${guest.config.type === "lxc" ? "CT" : "VM"} ${guest.config.vmid}`;
            return h("article", { key: guest.key, className: "pve-guest-card" },
              h("div", { className: "pve-guest-head" },
                h("div", null,
                  h("h3", null, guestNames[guest.key] || guestId),
                  h("p", null, `${guestNames[guest.key] ? `${guestId} · ` : ""}${guest.config.node} · ${hosts.find(host => host.id === guest.config.hostId)?.name || `Host ${guest.config.hostId}`}`)),
                h("span", { className: `pve-status ${stopping ? "pve-status-stopping" : running ? "pve-status-running" : ""}` }, statusLabel)
              ),
              guest.config.connectionHostId && h("p", { className: "pve-idle-progress" }, `Starts when connecting to ${hosts.find(host => host.id === guest.config.connectionHostId)?.name || `host ${guest.config.connectionHostId}`}`),
              running && guest.last?.cpuPercent != null && h("div", { className: "pve-metrics" },
                h("span", null, `CPU ${guest.last.cpuPercent}%`),
                h("span", null, `Uptime ${Math.floor((uptimeSeconds ?? guest.last.uptime) / 60)} min`)),
              countdown && h("div", { className: "pve-countdown", role: "timer", "aria-live": "off" },
                h("span", null, "Uptime shutdown in"),
                h("strong", null, countdown),
                remaining === 0 && h("small", null, "Limit reached. Shutdown is due on the next check."),
                remaining > 0 && guest.config.idleCpuPercent > 0 && h("small", null, "Low CPU may trigger shutdown sooner.")),
              guest.armed && !stopping && guest.config.idleCpuPercent > 0 && h("p", { className: "pve-idle-progress" }, `Low CPU checks ${guest.armed.idleSamples}/5`),
              guest.last?.error && h("p", { role: "alert", className: "mt-3 text-sm text-destructive" }, `Check failed: ${guest.last.error}`),
              stopping && h("p", { className: "mt-3 text-sm text-muted-foreground" }, "Graceful shutdown requested. Waiting for Proxmox to confirm the stop."),
              h("p", { className: "mt-3 text-sm text-muted-foreground" }, guest.armed ? "Automatic shutdown armed" : "Automatic shutdown off"),
              canManage && h("div", { className: "pve-actions pve-guest-actions" },
                !guest.armed && !stopping && h("button", { type: "button", className: button, disabled: working, onClick: () => running ? monitor(guest) : send("/start", guest.config) }, running ? "Monitor guest" : "Start guest"),
                running && !stopping && h("button", { type: "button", className: button, disabled: working, onClick: () => stop(guest) }, "Stop guest"),
                h("button", { type: "button", className: button, disabled: working, onClick: () => setForm(Object.fromEntries(Object.entries(guest.config).map(([key, value]) => [key, value == null ? "" : String(value)]))) }, "Edit"),
                guest.armed && h("button", { type: "button", className: button, disabled: working, onClick: () => send("/disarm", { key: guest.key }) }, "Cancel auto shutdown"),
                !guest.armed && h("button", { type: "button", className: button, disabled: working, onClick: () => send("/remove", { key: guest.key }) }, "Remove")
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
      if (!guest) return toast.error("No Proxmox guest is linked to this host");
      const name = `${guest.config.type === "lxc" ? "CT" : "VM"} ${guest.config.vmid}`;
      try {
        const { data } = await app.api.post("/start", { ...guest.config, allowRunning: true });
        const started = data?.guests?.find(item => item.key === guest.key)?.last?.status === "starting";
        toast.success(started ? `Started ${name}` : `${name} is already running`);
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
      if (!guest) return toast.error("No Proxmox guest is linked to this host");
      const name = `${guest.config.type === "lxc" ? "CT" : "VM"} ${guest.config.vmid}`;
      if (!globalThis.confirm(`Request a graceful shutdown for ${name}? Open sessions to ${host.name || "this host"} will be closed.`)) return;
      try {
        await app.api.post("/stop", { key: guest.key });
        toast.success(`Graceful shutdown requested for ${name}`);
      } catch (error) {
        toast.error(error.response?.data?.error || error.message);
      }
    },
  });
}
