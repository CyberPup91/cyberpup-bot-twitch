# cyberpup-bot-twitch

Twitch chat bot (Twurple + SQLite) with per-channel custom commands, `${weather}` / `${customapi}` template variables, and a web dashboard.

## Dashboard

The bot serves a web UI from the same process — command manager, channel join/part, and a live event log. Changes take effect immediately, no restart needed.

- URL: http://127.0.0.1:3000 (configurable via `DASHBOARD_HOST` / `DASHBOARD_PORT` in `.env`)
- There is no login, so keep it bound to `127.0.0.1` (the default) and use an SSH tunnel for remote access. Do not expose the port to the internet.
- `docker-compose.yaml` maps port 3000 by default.

## Auth

The bot account's token needs these scopes:

- `chat:read`, `chat:edit` — reading/sending chat
- `moderator:manage:announcements` — enables `$announce` (the bot account must also be a moderator in the channel)

## Chat commands

- `$cmd add|edit|delete|show|options !<trigger> ...` (mod+) — manage custom commands
- `$announce [color] <message>` (mod+) — Helix chat announcement (colors: blue, green, orange, purple)
- `$bot join|leave <channel>` (superadmin, home channel only) — join/part channels

Custom command responses support `${user}`, `${touser}`, `${channel}`, `${query}`, `${1}..${N}`, `${random.1-100}`, `${weather [location]}`, and `${customapi <url>}`.
