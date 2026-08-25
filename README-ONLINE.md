# HI-LO ARCADE — Online Multiplayer

Authoritative **Node.js + WebSocket** server (`server.js`) that serves the client (`index.html`)
and runs real-time game rooms. No build step, no framework.

## What works now (Phase 1)
- **Rooms**: create a room (get a 4-char code) or join one by code. Up to 8 players.
- **Speed Race**: the host starts; the server deals the *same* shuffled shoe to everyone at
  once, then asks for the final running count. Ranked by **correct first, then fastest**.
- Server owns the cards & the count, so nobody can desync or cheat the sequence.

Planned next: **Pop Quiz Race** (streaming + surprise prompts) → **shared authoritative
blackjack table** (seats, turns, synced betting).

## Run locally
```
npm install
npm start
```
Then open **http://localhost:3000** in two browser tabs (or two devices on your LAN),
click **🌐 ONLINE**, create a room in one, join with the code in the other, and race.

> Opening `index.html` directly (file://) still works for the single-player modes, but the
> ONLINE tab will tell you to run it through the server — WebSockets need a real origin.

## Deploy (so friends can join over the internet)

The server reads `PORT` from the environment and works behind any WebSocket-capable host.
Same-origin WS means **no config needed** — the client auto-uses `wss://<your-domain>`.

### Option A — Render (easiest, free tier)
1. Push this folder to a GitHub repo.
2. On Render: **New + → Blueprint**, select the repo. It reads `render.yaml`.
   (Or **New + → Web Service**, Build `npm install`, Start `npm start`.)
3. Deploy. Your app is at `https://<name>.onrender.com`. Share it.

### Option B — Docker (Fly.io / Railway / any container host)
```
docker build -t hilo-arcade .
docker run -p 3000:3000 hilo-arcade
```

### Notes
- Free tiers may **sleep** when idle; the first request wakes them (a few seconds).
- Rooms are **in-memory** — a server restart clears active rooms. Fine for casual play;
  we can add Redis later if you want persistence / horizontal scaling.
- `/health` returns `ok` for platform health checks.
