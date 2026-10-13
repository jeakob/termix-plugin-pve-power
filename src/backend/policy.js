export function evaluate(status, armed, config, now = Date.now()) {
  if (status?.status === "stopped" && !armed.shutdownRequestedAt && now - armed.requestedAt < 300_000) {
    return { action: "continue", bootEpoch: null, idleSamples: 0 };
  }
  if (!status || status.status !== "running" || !Number.isFinite(status.uptime) || status.uptime < 0) {
    return { action: "disarm", reason: "Guest is no longer running" };
  }

  const bootEpoch = now - status.uptime * 1000;
  if (armed.bootEpoch && Math.abs(bootEpoch - armed.bootEpoch) > 120_000) {
    return { action: "disarm", reason: "Guest was restarted outside this plugin" };
  }

  if (armed.shutdownRequestedAt) {
    return { action: "continue", bootEpoch: armed.bootEpoch || bootEpoch, idleSamples: armed.idleSamples };
  }

  if (config.maxUptimeMinutes > 0 && status.uptime >= config.maxUptimeMinutes * 60) {
    return { action: "shutdown", reason: "maximum uptime reached", bootEpoch, idleSamples: 0 };
  }

  const cpu = status.cpu;
  const idle = config.idleCpuPercent > 0 && status.uptime >= 600 &&
    Number.isFinite(cpu) && cpu >= 0 && cpu <= 1 && cpu * 100 <= config.idleCpuPercent;
  const idleSamples = idle ? armed.idleSamples + 1 : 0;
  if (idleSamples >= 5) {
    return { action: "shutdown", reason: "CPU stayed below threshold for five checks", bootEpoch, idleSamples };
  }
  return { action: "continue", bootEpoch: armed.bootEpoch || bootEpoch, idleSamples };
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings");
  const { hostId, node, vmid, idleCpuPercent, maxUptimeMinutes } = input;
  const type = input.type ?? "qemu";
  const connectionHostId = input.connectionHostId ?? null;
  if (type !== "qemu" && type !== "lxc") throw new Error("Choose a valid guest type");
  if (!Number.isSafeInteger(hostId) || hostId <= 0) throw new Error("Choose a valid Termix host ID");
  if (connectionHostId !== null && (!Number.isSafeInteger(connectionHostId) || connectionHostId <= 0 || connectionHostId === hostId)) throw new Error("Choose a valid guest connection host");
  if (typeof node !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(node)) throw new Error("Choose a valid Proxmox node name");
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999999999) throw new Error("Choose a valid VM ID");
  if (!Number.isInteger(idleCpuPercent) || idleCpuPercent < 0 || idleCpuPercent > 100) throw new Error("CPU threshold must be 0 to 100 percent");
  if (!Number.isInteger(maxUptimeMinutes) || maxUptimeMinutes < 0 || maxUptimeMinutes > 525600) throw new Error("Maximum uptime must be 0 to 525600 minutes");
  return { hostId, node, vmid, type, connectionHostId, idleCpuPercent, maxUptimeMinutes };
}
