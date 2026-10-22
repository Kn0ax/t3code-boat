# boat archiver

Runs once, applies the boat VM lifecycle rules, and exits. Run it from a timer on the machine
that hosts the home T3 server (the one holding the boat key).

For each running boat VM that T3 made, the rule applies when it holds for every thread on the VM:

- every thread deleted: the VM is deleted;
- every thread archived: each thread is copied to the home T3 server, then the VM is deleted;
- every thread snoozed, or idle with no message for `IDLE_MINUTES`: the VM is stopped.

Archived threads are copied home as soon as the archiver sees them. A VM is deleted only after
every copy succeeded. Stopped VMs are not read; picking one in Run on, or Start VM on its thread,
resumes it.

## Build

```sh
bun run build   # dist/t3-boat-archiver.mjs
```

It runs with Node 24 or later. Debian and Armbian ship an older Node, so install Node 24 on the
host (for example with fnm or NodeSource) and point `ExecStart` at it.

## Configure

| Variable       | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| `BOAT_API_KEY` | The boat key the home T3 server uses.                             |
| `T3_URL`       | The home T3 server's origin, for example `http://127.0.0.1:3773`. |
| `T3_TOKEN`     | See below.                                                        |
| `IDLE_MINUTES` | Optional, default `30`.                                           |
| `STATE_FILE`   | Optional, default `$XDG_STATE_HOME/t3-boat-archiver/state.json`.  |

The token needs only the `orchestration:operate` scope. `--token-only` prints a blank line after
the token, so take the first line:

```sh
t3 auth session issue --base-dir <T3 base dir> --scope orchestration:operate --ttl 365d --token-only | head -1
```

## systemd (user units)

`~/.config/t3-boat-archiver.env` holds the variables above (mode 600).

`~/.config/systemd/user/t3-boat-archiver.service`:

```ini
[Unit]
Description=T3 boat VM archiver

[Service]
Type=oneshot
EnvironmentFile=%h/.config/t3-boat-archiver.env
ExecStart=/usr/bin/env node %h/.local/lib/t3-boat-archiver.mjs
```

`~/.config/systemd/user/t3-boat-archiver.timer`:

```ini
[Unit]
Description=Run the T3 boat VM archiver every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now t3-boat-archiver.timer
journalctl --user -u t3-boat-archiver   # one JSON line per VM it acted on
```
