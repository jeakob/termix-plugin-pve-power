# Changelog

## 0.6.8

### Changed

- Add screenshots and a usage guide to the docs.
- Move all interface text into `locales/en.json`, ready for translation.
- Document every API route with OpenAPI.
- Remove an unneeded import query from the shutdown policy module.


## 0.6.7

### Changed

- Explain what the plugin does and the problem it solves in the README.
- Remove an unused packaging script.


## 0.6.6

### Changed

- Keep Termix’s SSH terminal as the default host-row action; guest start-and-connect remains an explicit host-menu action.


## 0.6.5

### Changed

- Document authenticated API-based webhook integrations in the Proxmox Power page.


## 0.6.4

### Changed

- Add a Proxmox Power host setting under Protocols and Plugins.
- Require both Proxmox Integration and Proxmox Power to be enabled for a source host.


## 0.6.3

### Changed

- Show only SSH-enabled hosts marked with Termix Proxmox integration in the Proxmox host selector.


## 0.6.2

### Changed

- Give the connect, start and shutdown host actions their own icons.
- Show the start-and-connect action only on hosts linked to a Proxmox guest, not on every SSH host.
- Opening a linked host whose guest is already running now connects straight away instead of waiting as if the guest had just started.

## 0.6.1

### Changed

- Add a Start Proxmox guest action that starts a linked guest without opening a terminal.

## 0.6.0

### Changed

- Rename the plugin to Proxmox Power with the ID `pve-power`. Saved guests must be added again.

## 0.5.8

### Changed

- Refresh the host list once linked guests load so the shutdown action appears without reopening Termix.

## 0.5.7

### Changed

- Add a Shut down Proxmox guest action to linked hosts in the host list.

## 0.5.6

### Changed

- Wait for a freshly started linked guest to accept SSH before opening its terminal.

## 0.5.5

### Changed

- Route host row clicks through a connection tab because Termix skips host action `run` handlers for row clicks.

## 0.5.4

### Changed

- Register the wake action even when Termix loads plugins before the user signs in.

## 0.5.3

### Changed

- Fetch saved host links on each host click so a new link takes effect without reloading Termix.

## 0.5.2

### Changed

- Let a linked host connect again while its guest is already running and monitored.

## 0.5.1

### Changed

- Reload the guest policy module on live plugin updates so connection host links are saved correctly.

## 0.5.0

### Changed

- Link a saved Proxmox guest to a Termix SSH host and start it automatically when that host is opened.
- Show a host action for linked guests and leave already running guests unchanged.

## 0.4.3

### Changed

- Show the Proxmox guest name on saved guest cards, including guests saved before this update.

## 0.4.2

### Changed

- Give the guest setup and saved guest cards reliable responsive spacing and a prominent uptime shutdown countdown.

## 0.4.1

### Changed

- Show a live countdown to the maximum uptime limit and progress toward the five low CPU checks.

## 0.4.0

### Changed

- Add a manual graceful Stop guest action for running VMs and LXC containers.
- Give guest setup and saved guest status separate panels with clearer actions and metrics.

## 0.3.1

### Changed

- Refresh the status of saved guests even when automatic shutdown is off.
- Allow explicitly monitoring an already running guest.

## 0.3.0

### Changed

- Request `users:impersonate` so background shutdown checks can run as the user who started each guest.
- Save and monitor multiple guests independently, migrating the existing guest and armed state.

## 0.2.0

### Changed

- Use a new plugin ID to load the corrected backend separately from earlier development installs.

## 0.1.4

### Changed

- Validate the selected guest in the start request, preventing stale configuration from producing an invalid Proxmox path.

## 0.1.3

### Changed

- Start the guest currently selected in the form and report backend failures in the tab.

## 0.1.2

### Changed

- Include LXC containers in discovery and support their start, status, and graceful shutdown commands.

## 0.1.1

### Changed

- Select a Termix SSH host and a named Proxmox QEMU VM from dropdowns.

## 0.1.0

### Changed

### Added

- Start one Proxmox VM and request graceful shutdown after sustained idle CPU use or a maximum uptime.
