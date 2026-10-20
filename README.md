# Pixels

A browser-based 3D multiplayer town. Walk around, chat, shop, take missions and ask the **Town Guide** (an AI assistant) to take you places. No install: it runs in a desktop browser.

- **Login:** username + email only (no password, no verification, preview-grade). The email is the account key.
- **Multiplayer:** one shared town room (up to 50 players), server-validated movement.
- **Economy:** in-game **coins** (mock, no real value). Shop with cosmetics and a test collectible.
- **Town Guide (AI):** natural language -> allowlisted game actions (navigate, open shop, list items, propose missions). Works offline with a built-in rules engine; uses Claude when an API key is configured.
- **Missions:** visit a place, deliver a parcel, treasure hunt. State, validation and rewards live on the server.
- **Solana (optional, Devnet only):** wallet sign-in and paying for items with Devnet SOL. Off by default, see [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Quick start

Requires Node 22+.

```bash
npm install
npm run dev          # server on :8787 + web on http://localhost:5173
```

Production-style (single process serving the built client):

```bash
npm run build
npm start            # http://localhost:8787
```

Open the page in two browser windows, log in with different usernames/emails, and you will see each other.

## Controls

| Key | Action |
| --- | --- |
| W A S D / arrows | Move (Shift to run) |
| Mouse drag / wheel | Look / zoom |
| E | Interact (shop counter, mission pickups, treasure) |
| Enter | Chat (Esc to cancel) |
| 1 / 2 / 3 | Wave / dance / cheer |
| T | Town Guide (AI) |
| I / H | Inventory / help |

## Configuration

Copy `.env.example` to `.env` (placeholders only; never commit real secrets).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Server port |
| `DATA_DIR` | `./data` | Where `db.json` is stored |
| `STATIC_DIR` | `apps/web/dist` | Built client to serve |
| `AI_PROVIDER` | `auto` | `auto` (Claude if key set, else rules), `anthropic`, `rules` |
| `ANTHROPIC_API_KEY` | - | Server-side only. Never exposed to the browser |
| `AI_MODEL` | `claude-haiku-5-5` | Model for the Town Guide |
| `AI_TIMEOUT_MS` / `AI_DAILY_LIMIT` / `AI_RATE_PER_MIN` | `15000` / `100` / `10` | Cost and abuse limits (per player) |
| `VITE_SERVER_URL` | same origin | Point the dev client at another server |

## Scripts

```bash
npm test         # unit + integration tests (shared, server, web)
npm run typecheck
npm run lint
npm run build
npm run e2e      # needs `npm run build` first; two headless browsers against the real server
```

## Architecture

```
apps/web      React + react-three-fiber client (3D town, HUD, chat, shop, AI panel)
apps/server   Node + ws server: accounts, realtime room, shop, missions, AI assistant
packages/shared  World data, collision, pathfinding, catalogue, mission rules, protocol (used by both)
```

- Positions are sent by the client at ~15 Hz and **validated by the server** (speed limit, collisions, bounds); invalid moves are rubber-banded. Remote players are interpolated.
- The server is authoritative for coins, inventory, equipment, missions and rewards. The client never sends balances or prices.
- The AI can only call allowlisted tools (`get_player_context`, `find_location`, `navigate_to`, `open_shop`, `list_shop_items`, `propose_purchase`, `list_available_quests`, `propose_mission`, `find_players`, `list_locations`). Purchases and missions are only *proposals*; the player confirms in the UI. Rewards and prices always come from server configuration.

## AI privacy, cost and limits

Chat with the Town Guide is private to the player. Messages are sent from the server to the configured AI provider only when an API key is set; otherwise nothing leaves the server. Each player is limited per minute and per UTC day (see variables above). If the provider fails or quota is exhausted, the assistant falls back to the offline rules engine and the game stays playable.

## Troubleshooting

- **"Reconnecting" banner:** the WebSocket dropped; the client retries with backoff. If you opened the game in a second tab, the first tab is disconnected on purpose.
- **Blank 3D view:** WebGL must be enabled. A notice appears if it is unavailable.
- **Port in use:** set `PORT` (server) and update `VITE_SERVER_URL` for the dev client.
- **Login with someone else's email gives their account** by design in this preview (no verification).

## Manual test checklist

1. Log in; the town renders and WASD moves you; you cannot walk through buildings.
2. Open a second window; both avatars appear and move smoothly.
3. Walk to the Pixel Market counter, press E, buy a coffee; coins drop; close with Esc.
4. Press T and ask "Take me to the shop"; the avatar walks there.
5. Ask "I'm bored"; accept the mission; complete it; coins increase once.
6. Kill the server: the client shows reconnecting, then recovers on restart.
