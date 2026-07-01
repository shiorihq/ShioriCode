# Remote access

ShioriCode always **runs on your machine** — it spawns the coding agents, reads
your repos, and runs shell commands locally. "Remote access" only changes how a
browser or the iOS app **reaches** that local server: it stays the execution
boundary, and a credential login is the authorization boundary.

> [!IMPORTANT]
> The server runs arbitrary shell commands and reads your provider credentials.
> Anyone who can authenticate has full access to your machine. Never expose it
> without credentials. Exposure is refused (and torn down at startup) unless
> credentials (or `--unsafe-no-auth`) are configured.

## The easy way: Settings → Remote

Open **Settings → Remote** and run the setup wizard. It walks through:

1. **How it's reached** — Tailscale (private tailnet), Tailscale Funnel
   (public link), or a **custom server** (your own reverse proxy / tunnel).
2. **Prerequisites** — live checks for Tailscale (installed, connected, tailnet
   HTTPS for Funnel), or your proxy URL for the custom method.
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
It keeps the bind on `127.0.0.1` (a reverse proxy / tunnel terminates TLS in
front) but turns on mandatory auth from the first request, and **fails closed**
at startup if no credentials are configured. Auth is also turned on
automatically if you bind a non-loopback interface (`--host 0.0.0.0` / a
LAN/Tailnet IP), or the moment exposure is enabled in Settings. Use
`--require-auth` to force it on even on loopback, or `--unsafe-no-auth` to
explicitly turn it off (dangerous).

Then pick **one** exposure option below. Options A and B are what the wizard's
Tailscale methods run for you; C and D pair with the wizard's **Custom server**
method (enter the resulting URL there so it's persisted, shown as a QR code,
and testable).

---

## Option A — Tailscale Serve (private, zero infra) ★ simplest

Reach the server from any device **on your tailnet** (e.g. your phone with the
Tailscale app). No public exposure, no DNS, no VPS.

```sh
tailscale up                                   # if not already running
tailscale serve --bg --https=443 127.0.0.1:3773
```

Open `https://samis-mac-studio.<your-tailnet>.ts.net` and log in. In the iOS app,
tap **Connect to a remote server** and enter that URL + your credentials.

Tailscale terminates TLS locally and the wire is WireGuard-encrypted end to end,
so the shared trust boundary is your tailnet plus the login.

## Option B — Tailscale Funnel (public HTTPS, zero infra)

Same as Serve, but reachable from **anywhere on the internet** (no Tailscale app
needed on the client). The login is now the entire boundary, so credentials are
mandatory (the `--remote` flag already enforces this).

```sh
tailscale up
tailscale funnel --bg --https=443 127.0.0.1:3773
```

Open the printed `https://samis-mac-studio.<your-tailnet>.ts.net` URL anywhere.

## Option C — Your Hetzner VPS as a reverse proxy over Tailscale (custom domain)

Serve a custom HTTPS domain from the VPS (`hermes-hetzner`, `65.21.141.237`) and
proxy it over the tailnet to the Mac. The Mac never opens a public port; the
VPS↔Mac hop is WireGuard-encrypted; the login is enforced on the Mac.

**Prerequisites**

1. Tailscale must be **running on the Mac** (`tailscale up`). The VPS already
   sees it on the tailnet as `samis-mac-studio` / `100.112.212.36`.
2. A DNS `A` record for a subdomain pointing at the VPS, e.g.
   `mac.shiori.ai → 65.21.141.237`. (Existing `*.shiori.ai` records are already
   in use — add a new one. There is no wildcard record.)

**On the VPS** (replace `mac.shiori.ai`):

```sh
# 1. Issue a cert for the new subdomain
sudo certbot certonly --nginx -d mac.shiori.ai

# 2. Install the site
sudo tee /etc/nginx/sites-available/shiori-remote >/dev/null <<'NGINX'
server {
    server_name mac.shiori.ai;

    # Proxy to the Mac over the tailnet (WireGuard-encrypted).
    location / {
        proxy_pass http://100.112.212.36:3773;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;          # WebSocket
        proxy_set_header Connection $connection_upgrade; # WebSocket
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    listen 443 ssl;
    ssl_certificate     /etc/letsencrypt/live/mac.shiori.ai/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mac.shiori.ai/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
server {
    listen 80;
    server_name mac.shiori.ai;
    return 301 https://$host$request_uri;
}
NGINX

# 3. WebSocket upgrade map (only if not already defined globally)
#    Add to /etc/nginx/conf.d/websocket.conf if `$connection_upgrade` is unset:
#      map $http_upgrade $connection_upgrade { default upgrade; "" close; }

sudo ln -sf /etc/nginx/sites-available/shiori-remote /etc/nginx/sites-enabled/shiori-remote
sudo nginx -t && sudo systemctl reload nginx
```

Open `https://mac.shiori.ai` and log in; use the same URL in the iOS app.

> The bottleneck for "from anywhere" with the VPS is the DNS record and Tailscale
> being up on the Mac — both are one-time. If you don't want a custom domain,
> Option B (Funnel) gives a public URL with none of this.

## Option D — Cloudflare Tunnel (public, managed)

```sh
cloudflared tunnel --url http://127.0.0.1:3773
```

Cloudflare prints a public `https://<random>.trycloudflare.com` URL.

> [!WARNING]
> Cloudflare terminates TLS at its edge, so Cloudflare can see decrypted traffic
> (terminal I/O, agent output). Treat it as an untrusted transport and prefer
> Tailscale or your own VPS for sensitive work. Credentials still gate access.

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

- `SHIORICODE_ALLOWED_ORIGINS="https://mac.shiori.ai"` — pin the browser origins
  allowed to open the WebSocket (defense-in-depth against CSRF/DNS-rebinding).
- Keep `credentials.json` / `sessions.json` out of any backup/sync that leaves
  the machine.
