# Assemble API

Node.js API and WebSocket server for Assemble Office. It keeps presence and movement state in one process, stores members/sessions/invites/chat in Supabase Postgres, and runs on the Mac mini. Vercel serves the separate UI and proxies HTTP `/api/*` requests here; the browser connects to `/ws` through Cloudflare Tunnel with a short-lived, one-use ticket.

## Supabase setup

1. Create a Supabase project and open its Connect panel. Copy the **Session Pooler** PostgreSQL connection string for the long-running Mac mini process. Set it as `DATABASE_URL` in the API's local `.env` file. Keep it private; the UI never receives database credentials or a Supabase service key.
2. Run [`supabase/schema.sql`](supabase/schema.sql) once in the Supabase SQL Editor. The app uses the private `assemble` schema directly over Postgres. Do not add that schema to the project's exposed Data API schemas; its tables have RLS enabled and no grants to `anon` or `authenticated`.
3. Copy `.env.example` to `.env` and set `AUTH_MODE=oidc`, `PUBLIC_ORIGIN` to the exact Vercel site URL, `WS_PUBLIC_ORIGIN` to the stable HTTPS hostname used by Cloudflare Tunnel, a random `SESSION_SECRET` of at least 32 characters, the allowed email domain and admin emails, plus the OIDC provider credentials.
4. Register these callback URLs with the identity provider:
   - `https://assemble-room.vercel.app/api/auth/google/callback`
   - `https://assemble-room.vercel.app/api/auth/microsoft/callback`

Use the callback URL for the provider you enable. If the frontend domain changes, update `PUBLIC_ORIGIN` and the identity-provider callback together.

To bring over an existing SQLite database, stop the old API, keep the database and its `-wal`/`-shm` sidecars together, and run `npm run import:sqlite -- --source <path-to-office.sqlite>` after setting `DATABASE_URL`. The importer is additive and safe to rerun; it does not delete rows from Supabase. Keep the existing `SESSION_SECRET` if browser sessions should remain valid.

## Local development

Use Node.js 24.15 or newer. Start a Supabase project and set `DATABASE_URL`, then:

```sh
npm install
npm run dev
```

The API listens on `127.0.0.1:4173`. Set `PUBLIC_ORIGIN=http://localhost:5173` and `WS_PUBLIC_ORIGIN=http://localhost:4173`; the UI Vite server proxies `/api/*` to this process. Demo sign-in is enabled only in local development.

## Mac mini service

1. Install Node.js 24 and Cloudflare Tunnel (`cloudflared`) on the Mac mini. Keep the mini awake and connected to the network.
2. Set up a named Cloudflare Tunnel with a stable hostname such as `api.example.com`, routing it to `http://127.0.0.1:4173`. Cloudflare Tunnel supports the app's WebSocket route; do not use a temporary Quick Tunnel URL for production.
3. In `.env`, set `HOST=127.0.0.1`, `PUBLIC_ORIGIN=https://assemble-room.vercel.app`, and `WS_PUBLIC_ORIGIN=https://api.example.com`. Start the API with `npm start` and confirm `https://api.example.com/api/health` returns `{"ok":true}`.
4. Install the API as a user LaunchAgent so it starts at login and restarts after a crash:

```sh
npm install
npm run install:launch-agent
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.assemble.api.plist"
launchctl kickstart -k gui/$(id -u)/com.assemble.api
```

Keep the `.env` file readable only by the Mac mini account (`chmod 600 .env`). Configure `cloudflared` to start automatically using [Cloudflare's macOS service guide](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/). The tunnel and API must both be running for rooms and WebSockets to be available.

## Vercel connection

Import `Assemble-UI` as a separate Vercel project. Add `ASSEMBLE_BACKEND_ORIGIN=https://api.example.com` to its Production and Preview environment variables, then redeploy. The Vercel function proxies API requests and session cookies to this service. The API returns its public WebSocket URL from `/api/ws-ticket`, so no database credentials or cookie sharing with the tunnel hostname are needed.

Check both `https://assemble-room.vercel.app/api/health` and `/api/config`. They should return JSON from this service. If `/api/config` returns an HTML 404 page, the UI project has not deployed its `api/[...path].mjs` function.

## Runtime model

Run one API process. Presence, room occupancy, and the WebSocket ticket list live in memory; members, appearances, sessions, invites, and retained chat live in Supabase Postgres. The ticket used during WebSocket upgrade expires after one minute and can be consumed once. A restart disconnects current users, who reconnect automatically.
