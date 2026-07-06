# Remote access

ShioriCode always **runs on your machine** — it spawns the coding agents, reads
your repos, and runs shell commands locally. "Remote access" only changes how a
browser or the iOS app **reaches** that local server: it stays the execution
boundary, and a credential login is the authorization boundary.

Remote access runs over **Tailscale only**. It needs no open ports, DNS
records, or certificates, and gives two modes:

- **Only my devices** (Tailscale Serve) — reachable from devices signed into
  your tailnet. Tailscale gates the network, your sign-in gates the app.
- **Public link** (Tailscale Funnel) — a public `https://….ts.net` address
  that works from any browser. Your sign-in is the only gate.

> [!IMPORTANT]
> The server runs arbitrary shell commands and reads your provider credentials.
> Anyone who can authenticate has full access to your machine. Never expose it
> without credentials. Exposure is refused (and torn down at startup) unless
> credentials (or `--unsafe-no-auth`) are configured.

## The easy way: Settings → Remote

Open **Settings → Remote** and run the setup wizard. It walks through:

1. **Who can reach it** — only your devices (private tailnet) or a public link.
2. **Prerequisites** — live checks that Tailscale is installed and connected
   (plus tailnet HTTPS for the public link), with download/admin-console links
   and automatic re-checking while you fix them.
3. **Sign-in** — set the owner username/password (hashed with scrypt into
   `~/shiori/userdata/credentials.json`, mode `0600`). The wizard signs the
   current browser in at the same time.
4. **Turn on** — applies the exposure, shows the URL + QR code, and can run a
   connection test that verifies the URL round-trips to _this_ server process.

No restart or flags are required: enabling exposure raises mandatory auth at
runtime (every data route and the `/ws` socket require a valid session; the
static app shell stays public so the login page can load). The chosen exposure
is persisted in `~/shiori/userdata/remote.json` and **reconciled at startup** —
after a reboot the server re-applies a drifted Tailscale config, or fails
closed (tears exposure down) if credentials have vanished.

Everything below is the manual/CLI equivalent for scripting or headless setups.

## Manual setup

### 1. Set credentials (once)

Set them in the wizard, or seed from the environment on first launch:

```sh
export SHIORICODE_USERNAME="sami"
export SHIORICODE_PASSWORD="a-long-passphrase"
```

To rotate later, use the Remote settings panel, or delete `credentials.json`
and relaunch with new env values.

### 2. (Optional) force remote mode from the CLI

```sh
shioricode --remote
```

`--remote` (alias `--expose`) marks the server as remote-reachable at startup.
It keeps the bind on `127.0.0.1` (Tailscale terminates TLS in front) but turns
on mandatory auth from the first request, and **fails closed** at startup if no
credentials are configured. Auth is also turned on automatically if you bind a
non-loopback interface (`--host 0.0.0.0` / a LAN/Tailnet IP), or the moment
exposure is enabled in Settings. Use `--require-auth` to force it on even on
loopback, or `--unsafe-no-auth` to explicitly turn it off (dangerous).

### 3. Run the exposure the wizard would

**Private (Tailscale Serve)** — reach the server from any device **on your
tailnet** (e.g. your phone with the Tailscale app). No public exposure, no DNS,
no VPS:

```sh
tailscale up                                   # if not already running
tailscale serve --bg --https=443 127.0.0.1:3773
```

Open `https://<machine>.<your-tailnet>.ts.net` and log in. In the iOS app, tap
**Connect to a remote server** and enter that URL + your credentials.

Tailscale terminates TLS locally and the wire is WireGuard-encrypted end to
end, so the shared trust boundary is your tailnet plus the login.

**Public (Tailscale Funnel)** — same, but reachable from **anywhere on the
internet** (no Tailscale app needed on the client). The login is the entire
boundary, so credentials are mandatory (the `--remote` flag already enforces
this). Funnel requires HTTPS certificates enabled on your tailnet (admin
console → DNS → Enable HTTPS):

```sh
tailscale up
tailscale funnel --bg --https=443 127.0.0.1:3773
```

Open the printed `https://<machine>.<your-tailnet>.ts.net` URL anywhere.

> [!NOTE]
> Fronting the server with your own reverse proxy or tunnel is not a supported
> exposure method — the app can't observe, repair, or fail-close a proxy it
> doesn't manage. If you do it anyway, you MUST launch with `--remote` so auth
> is enforced from the first request, and you own the transport's security.

---

## How auth works

- **Login** (`POST /api/auth/login`, username + password) returns an HttpOnly,
  `SameSite=Lax`, `Secure` session cookie (web) and a bearer token (native).
- The **web** app authenticates the WebSocket via the cookie (same origin), so
  no token ever rides in a URL. The **iOS** app uses `POST /api/mobile/login`
  and stores its device token in the Keychain.
- Sessions live in `~/shiori/userdata/sessions.json` (mode `0600`). Revoke a
  device from **Settings → Remote → Devices**, or delete its entry (or the
  file) and restart; rotate the password from the same panel.
- Constant-time comparisons; scrypt password hashing; the previously
  unauthenticated attachment and project-favicon routes are now gated.

## Optional hardening

- `SHIORICODE_ALLOWED_ORIGINS="https://<machine>.<your-tailnet>.ts.net"` — pin
  the browser origins allowed to open the WebSocket (defense-in-depth against
  CSRF/DNS-rebinding).
- Keep `credentials.json` / `sessions.json` out of any backup/sync that leaves
  the machine.
