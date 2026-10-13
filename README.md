# Proxmox Power for Termix

Save and start multiple QEMU VMs or LXC containers from Termix. Each started guest gets its own shutdown monitor, which requests a graceful shutdown after either five consecutive low CPU readings or a maximum guest uptime. CPU checks run once per minute after a ten-minute boot grace period. A threshold or uptime value of `0` disables that rule.

## Install

1. Use Termix **v26.10.0 or newer** and enable Plugin developer mode in Settings → General.
2. Download the latest `pve-power-*.tmxplug` file from [Releases](https://github.com/jeakob/termix-plugin-pve-power/releases/latest).
3. In Termix, open **Plugins → Install from file** and select the downloaded file. Grant the capabilities listed below when prompted.
4. Add the Proxmox node as a normal SSH host in Termix. In the host editor, enable both **Proxmox Integration** and **Proxmox Power**. Its SSH account must be permitted to run `pvesh` for this guest.
5. Open the **Proxmox Power** tab, select a Termix Proxmox host and a QEMU VM or LXC container by name, then press **Save guest** or **Start selected guest**. To start a guest when you open its Termix SSH host, also select **Termix connection host** before saving. Saved guests show their current status when the tab opens and refresh once a minute. A running guest can be added to automatic shutdown with **Monitor guest**, or shut down immediately with **Stop guest**.

### Capabilities

- `files:own` stores this plugin’s saved guest settings and monitoring state in its private data directory.
- `network:serve` serves the plugin’s authenticated API routes through Termix.
- `hosts:read` lists the Termix hosts available to the current user so you can select a Proxmox host and connection host.
- `ssh:connect` and `credentials:use` let the plugin run Proxmox `pvesh` commands through Termix’s SSH connection and saved authentication; the plugin does not read credential values.
- `users:impersonate` lets scheduled shutdown checks run as the user who armed monitoring, preserving that user’s access to the host.
- `ui:surface` adds the Proxmox Power tab and linked-host actions.

This plugin was previously named Proxmox Guest On Demand (`pve-guest-on-demand`). The new ID has its own settings, so save guests again after switching and uninstall the old plugin.

The plugin uses the Termix SSH connection for each host, so its jump host and authentication settings apply. Automatic shutdown applies only to guests it started or that you explicitly chose to monitor. **Stop guest** sends an immediate graceful shutdown request for a saved running guest, even when automatic shutdown is off. **Cancel auto shutdown** leaves a running guest on. A graceful shutdown request is never escalated to a forced stop. If a guest ignores it, the tab shows an error after five minutes. Existing single guest state is migrated on update, including an armed shutdown monitor.

The maximum uptime is the guest's total uptime reported by Proxmox. Monitored guests show a live countdown to that limit and the number of consecutive low CPU checks. The countdown is based on the most recent Proxmox sample and is corrected on each check. If you monitor an already running guest whose uptime exceeds the configured limit, the next check can request shutdown immediately.

Clicking a linked SSH host opens Termix’s default SSH terminal. The **Start Proxmox guest and connect** action remains available in the host menu; choosing it starts a linked Proxmox guest if it is stopped, then opens the SSH terminal. A guest already running is left running and connected normally. Linked hosts also get **Start Proxmox guest**, which starts the guest without opening a terminal, and a **Shut down Proxmox guest** action, which requests a graceful shutdown after confirmation. The separate Terminal action and reconnecting an existing tab bypass host actions in Termix. After starting a stopped guest, the plugin waits up to about two minutes for its SSH host to accept a connection before opening the terminal.

The CPU value is Proxmox's guest CPU usage percentage. Low CPU alone does not prove that a guest is safe to stop. Choose a threshold and uptime limit that suit the workload, and enable the QEMU guest agent where appropriate for reliable VM shutdown.

## Webhook integrations

Automation services can control saved guests through the authenticated Termix API. Create a Termix API key for a user with Proxmox Power **manage** permission, then send JSON `POST` requests to `/plugin-api/pve-power/start` with the selected guest config from `GET /plugin-api/pve-power/vm`, or to `/plugin-api/pve-power/stop` with `{ "key": "<guest key>" }`. Include `Authorization: Bearer <Termix API key>` and `Content-Type: application/json`. These are authenticated Termix API routes; the plugin does not expose a public unauthenticated webhook URL.

## Development

To build the plugin locally, run `npm ci`, `npm run build`, `npm run validate`, then `npm run pack`. `npm test` runs the shutdown policy and guest control route tests.
