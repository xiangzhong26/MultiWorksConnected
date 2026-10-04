# Self-hosting deployment guide

[Back to README](../README.en.md) · [简体中文](DEPLOY.zh-CN.md) · **English**

Run the application and store data on your own computer. A cloud server runs Caddy and frps to relay public traffic. Local-only use needs neither a domain nor a relay.

## 1. Prepare the application host

Ubuntu LTS is recommended; Ubuntu Desktop also works if you need a local browser. Install Node.js 24 LTS and check `node --version` and `command -v node`. The service template assumes `/usr/bin/node`; adjust it if necessary.

Copy the project to `/opt/multiworks`, then run:

```bash
sudo useradd --system --home /opt/multiworks --shell /usr/sbin/nologin multiworks
sudo install -d -o multiworks -g multiworks -m 700 /var/lib/multiworks
cd /opt/multiworks
npm ci --omit=dev
sudo cp .env.example .env
sudo chown root:multiworks .env
sudo chmod 640 .env
```

Keep public access disabled during initialization. Edit `.env`:

```ini
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/multiworks
PUBLIC_ORIGIN=
COOKIE_SECURE=false
MAX_FILE_MB=100
```

Install the application service:

```bash
sudo cp deploy/multiworks.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now multiworks
```

Open `http://127.0.0.1:3000` on the host and set a password of at least 12 characters. There is no default password. Finish setup **before** enabling frp or exposing the application.

For a host without a browser, create an SSH local forward from another computer:

```bash
ssh -L 3000:127.0.0.1:3000 USER@HOST_LAN_IP
```

Open `http://127.0.0.1:3000` on that computer while keeping the SSH session open.

## 2. Configure the relay

Point a domain's A record at the cloud server. Obtain matching frp versions from the [official releases](https://github.com/fatedier/frp/releases). Install executable `frps` at `/usr/local/bin/frps` on the cloud server and `frpc` at `/usr/local/bin/frpc` on the application host.

Create `/etc/frp` on both machines and copy the templates:

| Machine | Template | Destination |
| --- | --- | --- |
| Cloud | `deploy/frps.toml.example` | `/etc/frp/frps.toml` |
| Host | `deploy/frpc.toml.example` | `/etc/frp/frpc.toml` |

Replace the cloud IP and token placeholders. Generate a token with `openssl rand -hex 32` and use the same token on both sides. Never commit real configurations.

On the cloud server:

```bash
sudo useradd --system --shell /usr/sbin/nologin frp
sudo chown root:frp /etc/frp/frps.toml
sudo chmod 640 /etc/frp/frps.toml
```

On the application host:

```bash
sudo chown root:multiworks /etc/frp/frpc.toml
sudo chmod 640 /etc/frp/frpc.toml
```

Install `deploy/frps.service` on the cloud server and `deploy/frpc.service` on the host into `/etc/systemd/system/`. Run `sudo systemctl daemon-reload` on each, then `sudo systemctl enable --now frps` on the cloud and `sudo systemctl enable --now frpc` on the host.

The examples require TLS. For production, configure a certificate on frps and set `transport.tls.trustedCaFile` and `transport.tls.serverName` on frpc to verify the relay. See [frp TLS documentation](https://gofrp.org/en/docs/features/common/network/network-tls/).

## 3. Configure HTTPS

Install Caddy using its [official guide](https://caddyserver.com/docs/install). Use `deploy/Caddyfile.example` as `/etc/caddy/Caddyfile`, replacing the domain. Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy forwards HTTP and WebSocket traffic to cloud loopback port 18080. Do not add upload buffering, response caching, or request-body logging. The example does not persist messages or files in the cloud, but HTTPS terminates there and its administrator can technically read forwarded content. This is not end-to-end encryption.

Allow public TCP 80/443, frp TCP 7000, and restricted administrative access in the firewall and security group. Port 18080 binds to cloud loopback only; do not expose it publicly. Application port 3000 stays local to its host.

Certificate issuance needs working DNS and reachable ports. For mainland China regions, follow the provider's guidance for applicable domain and registration requirements.

## 4. Enable the public origin

After local setup, change the host's `.env`:

```ini
PUBLIC_ORIGIN=https://work.example.com
COOKIE_SECURE=true
```

Use your actual domain without a trailing slash, then run `sudo systemctl restart multiworks`. Other devices log in at that HTTPS address. Once configured, writes from the local HTTP address are intentionally rejected.

## 5. Uptime and backups

- Disable automatic sleep and check lid-close behavior. Use wired networking when practical.
- The relay cannot serve data while the host is offline.
- Keep the data directory private to the service user; never expose it as a static directory.
- Stop the application before backing up all of `/var/lib/multiworks`, including WAL/SHM files if present and the complete `files` directory; restart afterwards.
- Backups contain account data, content, and active sessions; protect them.

Diagnostics:

```bash
# Application host
sudo journalctl -u multiworks -u frpc -f
# Cloud server
sudo journalctl -u frps -u caddy -f
```

## Windows 11 host

Use Node.js 24, `npm ci`, and a local `.env`; initialize locally. Run frpc pointing to local port 3000. The cloud configuration stays the same.

Use Task Scheduler to start Node and frpc at boot even without an interactive login. Set the working directory, restart on failure, and disable sleep. This repository includes Ubuntu systemd templates; configure Windows tasks on the target machine.

## Acceptance checks

1. Log in on two devices and send messages in the same room.
2. Switch projects and confirm records stay separate.
3. Upload representative PDFs and archives, and download on the second device.
4. Disconnect and reconnect; confirm active-room catch-up.
5. Reboot the host and verify automatic startup.
6. Measure throughput on the actual home and cloud connections.

`npm test` checks application behavior with disposable data, not cloud configuration, uptime, or real-world performance.
