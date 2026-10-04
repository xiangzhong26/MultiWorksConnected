<p align="center"><img src="public/icon.svg" width="72" alt="MultiWorks Connected"></p>
<h1 align="center">MultiWorks Connected</h1>
<p align="center">A private, self-hosted workspace for moving text and files between your devices.</p>
<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>
<p align="center"><a href="#quick-start">Quick start</a> · <a href="#usage">Usage</a> · <a href="#deployment">Deployment</a> · <a href="#security-and-privacy">Security and privacy</a></p>

![MultiWorks Connected chat interface](artifacts/preview.jpg)

*An actual screenshot with sample messages from an isolated test environment, containing no personal work data. The interface currently uses Simplified Chinese; language links switch documentation only.*

## Overview

MultiWorks Connected is a personal workspace for sharing work across computers, phones, and tablets. Its chat interface organizes text, links, PDFs, and small archives into named project rooms.

The application and data live on your own computer. For remote access, a cloud server relays traffic without requiring a public IP address at home.

## Features

| Feature | Description |
| --- | --- |
| Project rooms | Create and rename rooms with separate message and file records |
| Live sync | WebSocket events, reconnection, catch-up for the active room |
| Text messages | Optimistic display, manual retry, deduplication, clickable links |
| Uploads | Drag-and-drop, multiple selection, progress, cancellation, retry; two concurrent uploads |
| Downloads | Authentication, browser-managed progress, HTTP Range support |
| History | Search text and filenames per room; load batches of 100 messages |
| Devices | Suggested OS/browser names, custom names, session listing and revocation |
| Access protection | Single-account login, session and origin checks, failed-login limits |
| Local storage | SQLite for accounts and messages; local disk for attachments |
| Responsive UI | Desktop/mobile layouts, unread indicators, session-local drafts |

## Architecture

```text
Computer / phone / tablet browser
                │ HTTPS
                ▼
Cloud server: Caddy + frps
                │ frp TLS tunnel
                ▼
Home computer: frpc → Node.js application
                          ├── SQLite: accounts, sessions, messages
                          └── Local disk: attachments
```

Local use needs no cloud server. For public access, the cloud forwards requests while the home computer persists application data and stays powered on and connected.

## Quick start

Requires **Node.js 24 LTS**, npm, and a modern browser. Supports Windows and Linux; Ubuntu LTS is recommended for a dedicated host.

### 1. Get the project

```bash
git clone https://github.com/xiangzhong26/MultiWorksConnected.git
cd MultiWorksConnected
npm ci
```

### 2. Create configuration

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Linux:

```bash
cp .env.example .env
```

### 3. Start

```bash
npm start
```

On the application host, open [http://127.0.0.1:3000](http://127.0.0.1:3000). Set a password of at least **12 characters** and a device name.

**There is no default password. Initialize locally before enabling public relay access.** The default setup listens on localhost only. Other devices cannot reach your host at that address; see the deployment guide.

## Usage

### Login and devices

1. After setup, log in on other browsers using the same password.
2. Names are suggested from the OS and browser, such as `Windows · Chrome`.
3. Select the bottom-left device name to rename it or revoke a device's sessions.
4. On mobile, open the top-left menu to manage devices or switch rooms.

Identity is per browser, not a hardware serial number. Private browsing or clearing storage creates a new identity; sessions expire after 30 days.

### Project rooms

- Select **＋** next to the room heading to create a named room.
- Select a room in the sidebar to switch projects.
- Use the header's edit button to rename the active room.
- Each room stores its own messages and attachments; all logged-in devices can access every room.

### Messages and files

- Type a message and select Send. **Enter** sends; **Shift + Enter** inserts a newline on desktop.
- Select Add file or drag files into the conversation; multiple selection is supported.
- Watch upload progress, cancel if needed, or select Retry after failure.
- Open the same room on another device to receive messages and files in real time.
- Select a file card to download; progress appears in the browser's download manager.

The default limit is **100 MB per file**. Upload retries retransmit the whole file; chunked and resumable uploads are not implemented.

### Search and deletion

- Search text and filenames in the active room; clear the field to return to normal history.
- Select Load earlier messages to retrieve older records.
- Select Delete beside a message and confirm to remove it and its attachment. **Deletion affects every device and cannot be undone.**

## Configuration

Set values in the local `.env` file and restart after changes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening address; localhost only by default |
| `PORT` | `3000` | Application port |
| `DATA_DIR` | `./data` | Storage directory, relative to the process working directory |
| `PUBLIC_ORIGIN` | Empty | Public origin, e.g. `https://work.example.com`, without a trailing slash |
| `COOKIE_SECURE` | `false` | Set to `true` for production HTTPS |
| `MAX_FILE_MB` | `100` | Per-file upload limit in MB |

Use the project root as the working directory. For production, use an absolute data path such as `/var/lib/multiworks`.

## Deployment

Run on an Ubuntu LTS laptop and use a cloud server for HTTPS and frp relay traffic. Systemd units for the application, frpc, and frps, plus a Caddy example, are included.

- **[English deployment guide](docs/DEPLOY.en.md)**: Ubuntu, initialization, relay, HTTPS, backups, and Windows notes.
- **[中文部署指南](docs/DEPLOY.zh-CN.md)**.
- Templates are in [`deploy/`](deploy/); replace domain, IP, and secret placeholders.

Validate two-device sync, file transfers, network recovery, and startup after reboot on your actual network. Throughput depends on host upload bandwidth, cloud bandwidth, and client connectivity.

## Security and privacy

- Passwords are salted scrypt hashes. Cookies use `HttpOnly` and `SameSite=Strict`; enable `Secure` for production HTTPS.
- Messages and downloads require authentication. Room separation organizes data; it is not multi-user access control.
- Public access uses HTTPS. The frp examples force TLS; configure certificate verification to authenticate the relay.
- HTTPS terminates on the cloud server, whose administrator can technically read forwarded content. **There is no end-to-end encryption or database/attachment encryption at rest.**
- Never commit real `.env` files, frp configuration, private keys, databases, attachments, logs, or backups.
- Test passwords are disposable fixtures; example tokens are placeholders, not default credentials.

Default storage:

```text
data/
├── workspaces.sqlite      # Account, devices, sessions, rooms, messages
├── workspaces.sqlite-wal  # May exist while running
├── workspaces.sqlite-shm  # May exist while running
└── files/                 # Attachments with randomized storage names
```

`.gitignore` excludes default data and common secrets, but cannot prevent forced commits or protect every custom attachment directory. Keep custom data outside the repository or add ignore rules. For backups, stop the service, copy the entire data directory, then restart; backups contain sensitive data and valid sessions.

## Development and validation

```bash
npm test
```

Integration tests use a temporary directory and cover login protection, origins, live events, room isolation, deduplication, Unicode filenames, upload limits, file authorization, Range downloads, session revocation, search, deletion, and restart persistence.

Passing tests do not constitute public deployment or performance acceptance; validate on real devices and networks.

## FAQ

**Why can't another device open `127.0.0.1:3000`?**

It refers to the requesting device itself. The default setup is local to the application host; cross-device access needs the relay entry point.

**Why is the page unavailable or reconnecting?**

Check that the host is awake and online, then check the application, frpc, cloud frps, and Caddy.

**Why is an origin mismatch reported?**

Match `PUBLIC_ORIGIN` to the actual origin, including scheme and port, with no trailing slash. Restart after changing it.

**Why did an upload fail?**

Check `MAX_FILE_MB`, disk space, and connectivity. Retry after network recovery; the entire file is uploaded again.

**Does it support teams and separate accounts?**

This is a personal single-account tool. All devices share permissions; member accounts, room permissions, and audit logs are not implemented.

## Project status

An initial locally runnable version with self-hosting templates. The interface currently supports Simplified Chinese only. No license has been specified.
