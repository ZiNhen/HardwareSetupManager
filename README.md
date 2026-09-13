# Hardware Setup Manager

Hardware Setup Manager is a clean, lightweight web app for managing shared hardware setup boards.

This branch, `feature/online-multiuser`, runs as one small Node.js process:

```text
Browser -> Express static app + REST API -> SQLite
```

The original local-only version remains on the local/main branch history. This online branch keeps the existing HTML/CSS/Vanilla JavaScript UI and adds shared multi-project persistence.

## Features

- Multi-project Project Browser
- Shared Checkpoint and Container hardware maps
- 22 x 5 setup board with fixed hardware zones
- Squib, AOD, Sensor, Physical Switch, Mechanical Switch
- Multiple sensors in one logical position
- Copy/cut/paste selected cells
- Copy/Paste setup between Checkpoint and Container
- JSON Import and Export compatible with the local version
- Polling-based multi-user sync
- Per-position saves with revision conflict detection
- SQLite WAL mode for practical LAN multi-user use

## Local Development

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

On Windows, you can also double-click:

```text
start-server.bat
```

The batch file installs dependencies once if `node_modules` is missing, then starts the server.

## LAN Deployment

1. Install Node.js 24 LTS or newer on the server PC.
2. Clone the repository.
3. Switch to this branch:

```bash
git switch feature/online-multiuser
```

4. Run:

```bash
npm install
npm start
```

Other trusted devices on the same LAN can open:

```text
http://SERVER_IP:3000
```

On Windows, allow TCP port `3000` in Windows Firewall if other devices cannot connect.

Run only on a trusted LAN/VPN unless authentication is added.

## Database

SQLite database location:

```text
data/hardware-setup.db
```

Runtime database files are ignored by Git:

```text
data/*.db
data/*.db-shm
data/*.db-wal
```

Tables are created automatically on first `npm start`.

## Backup

Create a timestamped SQLite backup:

```bash
npm run backup
```

Backups are written to:

```text
backups/
```

## Restore

1. Stop the server.
2. Copy the backup database over:

```text
data/hardware-setup.db
```

3. Start the server again:

```bash
npm start
```

## Remote Access Options

- Same LAN: use `http://SERVER_IP:3000`.
- Trusted users over the internet: use Tailscale so clients and server share a private Tailnet.
- Public URL: place Cloudflare Tunnel in front of the server.

Tailscale and Cloudflare Tunnel are deployment options, not source-code dependencies.

## API

- `GET /api/health`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `DELETE /api/projects/:projectId`
- `GET /api/projects/:projectId/updates`
- `PUT /api/projects/:projectId/setups/:setupType`
- `PUT /api/projects/:projectId/setups/:setupType/positions/:positionId`
- `DELETE /api/projects/:projectId/setups/:setupType/positions/:positionId`

## Current Limits

- No authentication yet.
- No WebSocket realtime; sync uses lightweight polling.
- Conflict handling is per-position and intentionally simple.
- `node:sqlite` keeps dependencies low, but requires Node.js 24+.
