import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, validateConfig } from "./policy.js";

function run(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error("Proxmox command timed out"));
      }, 30_000);
      stream.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.length > 1_000_000) stream.close();
      });
      stream.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (stderr.length > 1_000_000) stream.close();
      });
      stream.on("error", reject);
      stream.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Proxmox command failed: ${stderr.trim() || `exit ${code}`}`));
        else resolve(stdout.trim());
      });
    });
  });
}

async function pvesh(ctx, config, path, method) {
  const { client, dispose } = await ctx.ssh.connect(config.hostId, { purpose: "pve-power", profile: "background" });
  try {
    return await run(client, `pvesh ${method} ${path} --output-format json`);
  } finally {
    dispose();
  }
}

async function status(ctx, config) {
  config = validateConfig(config);
  const path = `/nodes/${config.node}/${config.type}/${config.vmid}/status/current`;
  const value = JSON.parse(await pvesh(ctx, config, path, "get"));
  if (!value || typeof value !== "object" || !["running", "stopped"].includes(value.status)) {
    throw new Error("Proxmox returned an invalid guest status");
  }
  if (value.status === "running" && (!Number.isFinite(value.uptime) || value.uptime < 0)) {
    throw new Error("Proxmox returned an invalid guest uptime");
  }
  return value;
}

const guestKey = config => `${config.hostId}:${config.type}:${config.node}:${config.vmid}`;

export async function activate(ctx) {
  const statePath = join(await ctx.files.dataDir(), "vm.json");
  let stored;
  try {
    stored = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    stored = {};
  }
  const guests = Array.isArray(stored.guests) ? stored.guests : stored.config ? [{ config: stored.config, armed: stored.armed, last: stored.last }] : [];
  const state = { guests: guests.map(guest => {
    const config = validateConfig(guest.config);
    return { key: guestKey(config), config, armed: guest.armed || null, last: guest.last || null };
  }) };
  let busy = false;

  async function save() {
    const temp = `${statePath}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, statePath);
  }

  function view() {
    return { guests: state.guests.map(guest => ({
      key: guest.key,
      config: guest.config,
      armed: guest.armed && { shutdownRequestedAt: guest.armed.shutdownRequestedAt || null, idleSamples: guest.armed.idleSamples || 0 },
      last: guest.last,
    })) };
  }

  async function checkHost(config) {
    const allowed = await ctx.hosts.checkAccess(config.hostId, "manage");
    if (allowed === false) throw new Error("Manage access to the Proxmox host is required");
    if (config.connectionHostId) {
      const guestAllowed = await ctx.hosts.checkAccess(config.connectionHostId, "manage");
      if (guestAllowed === false) throw new Error("Manage access to the guest connection host is required");
    }
  }

  async function poll() {
    if (busy || !state.guests.some(guest => guest.armed)) return;
    busy = true;
    try {
      for (const guest of state.guests) {
        if (!guest.armed) continue;
        try {
          await ctx.asUser(guest.armed.userId, async () => {
            await checkHost(guest.config);
            const current = await status(ctx, guest.config);
            guest.last = { status: current.status, cpuPercent: Math.round(current.cpu * 1000) / 10, uptime: current.uptime, checkedAt: Date.now(), error: null };
            const decision = evaluate(current, guest.armed, guest.config);
            if (decision.action === "disarm") {
              guest.armed = null;
            } else if (decision.action === "shutdown") {
              const { node, type, vmid } = guest.config;
              await pvesh(ctx, guest.config, `/nodes/${node}/${type}/${vmid}/status/shutdown`, "create");
              ctx.log.info(`Requested graceful shutdown of ${type} ${vmid}: ${decision.reason}`);
              guest.armed.shutdownRequestedAt = Date.now();
              guest.last.reason = decision.reason;
            } else {
              guest.armed.bootEpoch = decision.bootEpoch;
              guest.armed.idleSamples = decision.idleSamples;
              if (guest.armed.shutdownRequestedAt) {
                guest.last.reason = "Graceful shutdown pending";
                if (Date.now() - guest.armed.shutdownRequestedAt > 300_000) guest.last.error = "Guest is still running five minutes after shutdown was requested";
              }
            }
          });
        } catch (error) {
          guest.last = { ...guest.last, checkedAt: Date.now(), error: error.message };
          ctx.log.error(`Guest ${guest.key} check failed: ${error.message}`);
        }
      }
      await save();
    } catch (error) {
      ctx.log.error(`Could not save guest checks: ${error.message}`);
    } finally { busy = false; }
  }

  const router = ctx.http.router();
  router.use(ctx.rbac.require("use"));
  /**
   * @openapi
   * components:
   *   schemas:
   *     PvePowerConfig:
   *       type: object
   *       required: [hostId, node, vmid, type, idleCpuPercent, maxUptimeMinutes]
   *       properties:
   *         hostId: { type: integer, description: Termix host of the Proxmox node }
   *         node: { type: string, description: Proxmox node name }
   *         vmid: { type: integer, minimum: 100 }
   *         type: { type: string, enum: [qemu, lxc] }
   *         connectionHostId: { type: integer, nullable: true, description: Termix host that starts this guest on connect }
   *         idleCpuPercent: { type: integer, minimum: 0, maximum: 100, description: 0 disables the idle CPU rule }
   *         maxUptimeMinutes: { type: integer, minimum: 0, maximum: 525600, description: 0 disables the uptime rule }
   *     PvePowerStart:
   *       allOf:
   *         - $ref: '#/components/schemas/PvePowerConfig'
   *         - type: object
   *           properties:
   *             allowRunning: { type: boolean, description: Return success instead of 409 when the guest already runs }
   *     PvePowerKey:
   *       type: object
   *       required: [key]
   *       properties:
   *         key: { type: string, description: Guest key from GET /plugin-api/pve-power/vm }
   *     PvePowerGuests:
   *       type: object
   *       properties:
   *         guests:
   *           type: array
   *           items:
   *             type: object
   *             properties:
   *               key: { type: string }
   *               config: { $ref: '#/components/schemas/PvePowerConfig' }
   *               armed: { type: object, nullable: true, description: Set while automatic shutdown is armed }
   *               last: { type: object, nullable: true, description: Last status, CPU, uptime and error }
   */
  /**
   * @openapi
   * /plugin-api/pve-power/vm:
   *   get:
   *     summary: List saved guests and their last status
   *     description: Needs the Proxmox Power use permission.
   *     tags:
   *       - Proxmox Power
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   */
  router.get("/vm", (_req, res) => res.json(view()));
  /**
   * @openapi
   * /plugin-api/pve-power/refresh:
   *   post:
   *     summary: Check the status of every guest that is not being monitored
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   */
  router.post("/refresh", ctx.rbac.require("manage"), async (_req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    busy = true;
    try {
      for (const guest of state.guests) {
        if (guest.armed) continue;
        try {
          await checkHost(guest.config);
          const current = await status(ctx, guest.config);
          const stopping = current.status === "running" && guest.last?.stopRequestedAt;
          const pending = stopping && Date.now() - stopping <= 300_000;
          guest.last = { status: pending ? "stopping" : current.status, cpuPercent: Math.round(current.cpu * 1000) / 10, uptime: current.uptime, checkedAt: Date.now(), error: stopping && !pending ? "Guest is still running five minutes after shutdown was requested" : null,
            ...(pending ? { stopRequestedAt: stopping, reason: "manual stop" } : {}) };
        } catch (error) {
          guest.last = { ...guest.last, checkedAt: Date.now(), error: error.message };
        }
      }
      await save();
      res.json(view());
    } catch (error) { res.status(500).json({ error: `Could not refresh guests: ${error.message}` }); }
    finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/hosts:
   *   get:
   *     summary: List the SSH hosts this user can pick as Proxmox or connection hosts
   *     description: Needs the Proxmox Power use permission.
   *     tags:
   *       - Proxmox Power
   *     responses:
   *       200:
   *         description: Hosts with id, name and whether Proxmox Power is enabled on them
   */
  router.get("/hosts", async (_req, res) => {
    try {
      const hosts = await ctx.hosts.list();
      // list() only carries a summary, so read this plugin's own host switch.
      res.json(await Promise.all(hosts.map(async ({ id, name }) => ({ id, name, proxmox: await ctx.settings.getHost(id, "enabled") === true }))));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/vms:
   *   get:
   *     summary: List the VMs and containers on a Proxmox host
   *     description: Needs the Proxmox Power use permission and manage access to the host.
   *     tags:
   *       - Proxmox Power
   *     parameters:
   *       - in: query
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Guests with type, vmid, node, name and status
   *       400:
   *         description: Invalid host ID
   *       502:
   *         description: Proxmox could not be reached
   */
  router.get("/vms", async (req, res) => {
    const hostId = Number(req.query.hostId);
    if (!Number.isSafeInteger(hostId) || hostId <= 0) return res.status(400).json({ error: "Choose a valid Termix host" });
    try {
      await checkHost({ hostId });
      const value = JSON.parse(await pvesh(ctx, { hostId }, "/cluster/resources --type vm", "get"));
      if (!Array.isArray(value)) throw new Error("Proxmox returned an invalid guest list");
      res.json(value.filter(vm => (vm.type === "qemu" || vm.type === "lxc") && Number.isSafeInteger(vm.vmid) && typeof vm.node === "string")
        .map(({ type, vmid, node, name, status }) => ({ type, vmid, node, name: name || `${type === "lxc" ? "CT" : "VM"} ${vmid}`, status })));
    } catch (error) { res.status(502).json({ error: error.message }); }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/config:
   *   post:
   *     summary: Save a guest and its shutdown rules
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerConfig'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       400:
   *         description: Invalid settings
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   */
  router.post("/config", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    let config;
    try { config = validateConfig(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    const key = guestKey(config);
    const existing = state.guests.find(guest => guest.key === key);
    if (existing?.armed) return res.status(409).json({ error: "Cancel monitoring before changing this guest" });
    if (config.connectionHostId && state.guests.some(guest => guest.key !== key && guest.config.connectionHostId === config.connectionHostId)) {
      return res.status(409).json({ error: "That Termix connection host is already linked to another guest" });
    }
    busy = true;
    try {
      await checkHost(config);
      const previous = state.guests;
      state.guests = [...state.guests.filter(guest => guest.key !== key), { key, config, armed: null, last: existing?.last || null }];
      try { await save(); } catch (error) { state.guests = previous; throw error; }
      res.json(view());
    } catch (error) {
      ctx.log.error(`Configuration failed: ${error.message}`);
      res.status(500).json({ error: `Could not save guest: ${error.message}` });
    } finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/start:
   *   post:
   *     summary: Start a guest and arm its automatic shutdown
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerStart'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       400:
   *         description: Invalid settings
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   *       502:
   *         description: Proxmox could not start the guest
   */
  router.post("/start", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    let config;
    try {
      if (!req.body?.type) throw new Error("Select a guest and try again");
      config = validateConfig(req.body);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    const key = guestKey(config);
    const existing = state.guests.find(guest => guest.key === key);
    if (existing?.armed && req.body?.allowRunning !== true) return res.status(409).json({ error: "Guest is already being monitored" });
    if (config.connectionHostId && state.guests.some(guest => guest.key !== key && guest.config.connectionHostId === config.connectionHostId)) {
      return res.status(409).json({ error: "That Termix connection host is already linked to another guest" });
    }
    busy = true;
    try {
      await checkHost(config);
      const current = await status(ctx, config);
      if (current.status !== "stopped") {
        if (current.status === "running" && req.body?.allowRunning === true) {
          // Callers treat "starting" as "we just turned it on", so don't hand back a stale one for a guest already up.
          if (existing?.last?.status === "starting") existing.last = { status: "running", cpuPercent: Math.round(current.cpu * 1000) / 10, uptime: current.uptime, checkedAt: Date.now(), error: null };
          return res.json(view());
        }
        return res.status(409).json({ error: "Guest is already running; use Monitor running guest" });
      }
      if (existing?.armed) return res.status(409).json({ error: "Guest is already being monitored" });
      const previous = state.guests;
      const guest = { key, config, armed: { userId: ctx.currentActor(), requestedAt: Date.now(), bootEpoch: null, idleSamples: 0 }, last: { status: "starting", checkedAt: Date.now(), error: null } };
      state.guests = [...state.guests.filter(item => item.key !== key), guest];
      try { await save(); } catch (error) { state.guests = previous; throw error; }
      try { await pvesh(ctx, config, `/nodes/${config.node}/${config.type}/${config.vmid}/status/start`, "create"); }
      catch (error) {
        guest.armed = null;
        guest.last = { status: "stopped", checkedAt: Date.now(), error: error.message };
        await save();
        throw error;
      }
      ctx.log.info(`Started Proxmox ${config.type} ${config.vmid}`);
      res.json(view());
    } catch (error) {
      ctx.log.error(`Start failed: ${error.message}`);
      res.status(502).json({ error: `Could not start guest: ${error.message}` });
    } finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/ssh-ready:
   *   post:
   *     summary: Check whether a started guest accepts SSH on its connection host
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerKey'
   *     responses:
   *       200:
   *         description: "{ ready: boolean }"
   *       404:
   *         description: Guest has no connection host
   */
  router.post("/ssh-ready", ctx.rbac.require("manage"), async (req, res) => {
    const guest = state.guests.find(item => item.key === req.body?.key);
    if (!guest?.config.connectionHostId) return res.status(404).json({ error: "Guest has no connection host" });
    try { await checkHost(guest.config); } catch (error) { return res.status(403).json({ error: error.message }); }
    const attempt = ctx.ssh.connect(guest.config.connectionHostId, { purpose: "pve-power", profile: "background" });
    let timer;
    try {
      const connection = await Promise.race([attempt, new Promise(resolve => { timer = setTimeout(resolve, 10_000, null); })]);
      if (!connection) {
        attempt.then(late => late.dispose(), () => {});
        return res.json({ ready: false });
      }
      connection.dispose();
      res.json({ ready: true });
    } catch { res.json({ ready: false }); }
    finally { clearTimeout(timer); }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/adopt:
   *   post:
   *     summary: Arm automatic shutdown for a guest that is already running
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerKey'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       404:
   *         description: Guest not found
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   */
  router.post("/adopt", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    const guest = state.guests.find(item => item.key === req.body?.key);
    if (!guest) return res.status(404).json({ error: "Guest not found" });
    if (guest.armed) return res.status(409).json({ error: "Guest is already being monitored" });
    busy = true;
    try {
      await checkHost(guest.config);
      const current = await status(ctx, guest.config);
      if (current.status !== "running") return res.status(409).json({ error: "Guest is not running" });
      const previous = { armed: guest.armed, last: guest.last };
      guest.armed = { userId: ctx.currentActor(), requestedAt: Date.now(), bootEpoch: Date.now() - current.uptime * 1000, idleSamples: 0 };
      guest.last = { status: "running", cpuPercent: Math.round(current.cpu * 1000) / 10, uptime: current.uptime, checkedAt: Date.now(), error: null };
      try { await save(); } catch (error) { guest.armed = previous.armed; guest.last = previous.last; throw error; }
      res.json(view());
    } catch (error) { res.status(502).json({ error: `Could not monitor guest: ${error.message}` }); }
    finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/stop:
   *   post:
   *     summary: Request a graceful shutdown of a guest
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerKey'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       404:
   *         description: Guest not found
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   *       502:
   *         description: Proxmox could not shut down the guest
   */
  router.post("/stop", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    const guest = state.guests.find(item => item.key === req.body?.key);
    if (!guest) return res.status(404).json({ error: "Guest not found" });
    if (guest.armed?.shutdownRequestedAt || guest.last?.stopRequestedAt) return res.status(409).json({ error: "Graceful shutdown was already requested" });
    busy = true;
    try {
      await checkHost(guest.config);
      const current = await status(ctx, guest.config);
      if (current.status !== "running") return res.status(409).json({ error: "Guest is not running" });
      const { node, type, vmid } = guest.config;
      await pvesh(ctx, guest.config, `/nodes/${node}/${type}/${vmid}/status/shutdown`, "create");
      const requestedAt = Date.now();
      if (guest.armed) guest.armed.shutdownRequestedAt = requestedAt;
      guest.last = { status: "stopping", checkedAt: requestedAt, cpuPercent: Math.round(current.cpu * 1000) / 10, uptime: current.uptime, reason: "manual stop", error: null,
        ...(!guest.armed ? { stopRequestedAt: requestedAt } : {}) };
      await save();
      ctx.log.info(`Requested graceful shutdown of ${type} ${vmid} manually`);
      res.json(view());
    } catch (error) { res.status(502).json({ error: `Could not stop guest: ${error.message}` }); }
    finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/disarm:
   *   post:
   *     summary: Cancel automatic shutdown for a guest
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerKey'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       404:
   *         description: Guest not found
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   */
  router.post("/disarm", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    const guest = state.guests.find(item => item.key === req.body?.key);
    if (!guest) return res.status(404).json({ error: "Guest not found" });
    busy = true;
    try {
      const previous = guest.armed;
      guest.armed = null;
      try { await save(); } catch (error) { guest.armed = previous; throw error; }
      res.json(view());
    } catch (error) {
      ctx.log.error(`Cancel failed: ${error.message}`);
      res.status(500).json({ error: `Could not cancel monitoring: ${error.message}` });
    } finally { busy = false; }
  });
  /**
   * @openapi
   * /plugin-api/pve-power/remove:
   *   post:
   *     summary: Remove a saved guest
   *     description: Needs the Proxmox Power manage permission.
   *     tags:
   *       - Proxmox Power
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/PvePowerKey'
   *     responses:
   *       200:
   *         description: The saved guests
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PvePowerGuests'
   *       404:
   *         description: Guest not found
   *       409:
   *         description: Another guest check is in progress or the guest is in the wrong state
   */
  router.post("/remove", ctx.rbac.require("manage"), async (req, res) => {
    if (busy) return res.status(409).json({ error: "Guest check in progress" });
    const guest = state.guests.find(item => item.key === req.body?.key);
    if (!guest) return res.status(404).json({ error: "Guest not found" });
    if (guest.armed) return res.status(409).json({ error: "Cancel monitoring before removing this guest" });
    busy = true;
    try {
      const previous = state.guests;
      state.guests = state.guests.filter(item => item.key !== guest.key);
      try { await save(); } catch (error) { state.guests = previous; throw error; }
      res.json(view());
    } catch (error) {
      ctx.log.error(`Remove failed: ${error.message}`);
      res.status(500).json({ error: `Could not remove guest: ${error.message}` });
    } finally { busy = false; }
  });

  ctx.schedule.every(60_000, poll);
}
