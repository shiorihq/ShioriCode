# ShioriCode CLI

Open the current directory in ShioriCode Desktop, falling back to the local web UI:

```bash
shioricode open
shioricode open /path/to/project
```

The command exits with a clear error instead of trying to launch a browser when no graphical
session is available. Headless machines should be connected through ShioriCode Link from a desktop or
mobile client.

Run ShioriCode on a workstation or headless server and use the desktop or iPhone app as the UI.

```sh
npm install -g shioricode
sudo shioricode service install
sudo shioricode doctor
sudo shioricode link connect --name "Build server"
```

`service install` defaults to a dedicated operating-system account and installs the native background mechanism for the host: systemd on Linux, launchd on macOS, or a startup task on Windows. ShioriCode listens on loopback and keeps a local recovery login.

Account selection and service paths are explicit CLI options. Reuse the invoking user when you want the service to inherit that user's provider homes and credentials:

```sh
shioricode service install --account current --no-recovery-login

# Or customize a dedicated account and service layout.
sudo shioricode service install \
  --account dedicated \
  --user shioricode \
  --home-dir /var/lib/shioricode \
  --state-dir /var/lib/shioricode \
  --workspace-dir /srv/shioricode/workspaces \
  --log-file /var/log/shioricode/server.log \
  --service-path /usr/local/bin:/usr/bin:/bin \
  --port 3773 \
  --recovery-username owner \
  --recovery-password-file /root/shioricode-recovery-password
```

`--account current` installs a per-user systemd service, macOS LaunchAgent, or Windows scheduled task without administrator access. `--account dedicated` installs the system-level service and still requires `sudo`/Administrator. `--no-recovery-login` keeps hosted access GitHub-only; omit it when you also want a direct/Tailscale recovery login. `--recovery-password-file` avoids exposing that password through shell history or the process list. Without either flag, installation generates a recovery password and prints it once. The selected account, paths, and port are persisted so subsequent `service`, `doctor`, `remote`, and `link` commands target the same installation.

The command also stages a private, read-only copy of Node and ShioriCode beneath the service data directory. The daemon therefore keeps working even when the npm installation came from NVM, a macOS user directory, or Windows AppData. After upgrading the global npm package, run `service install` again to atomically switch the background service to the new runtime.

Run service commands with `sudo` on Linux/macOS or from an Administrator terminal on Windows.

`link connect` prints a `shiori.codes` URL and short code. Open it on any computer, sign in with GitHub, and leave the command running until it prints the new `https://…link.shiori.codes` endpoint.

Useful commands:

```sh
sudo shioricode service status
sudo shioricode service logs
sudo shioricode service restart
sudo shioricode link status
sudo shioricode link list
sudo shioricode link disconnect
sudo shioricode doctor
```

## Tailscale remote access

ShioriCode can use an existing Tailscale installation instead of ShioriCode Link. Install
Tailscale and connect the machine to your tailnet first, then choose private tailnet access or a
public Funnel URL:

```sh
sudo tailscale up

# Private: only devices signed into the same tailnet can connect.
sudo shioricode remote tailscale serve

# Or public: reachable from any browser, behind ShioriCode sign-in.
sudo shioricode remote tailscale funnel

sudo shioricode remote status
sudo shioricode remote off
```

On Linux, the enable command grants the dedicated `shioricode` service account Tailscale operator
access so the daemon can restore the chosen exposure after a restart. Tailscale itself remains a
separate install and ShioriCode never joins a tailnet on the user's behalf.

Service removal preserves the service account and all ShioriCode data. Provider CLIs such as Codex, Claude Code, and Kimi Code are detected and explained by `shioricode doctor`; they are never installed or authenticated automatically.
