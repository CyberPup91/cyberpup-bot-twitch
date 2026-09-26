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

- `$cmd add|edit|delete|show|options $<trigger> ...` (mod+) — manage custom commands (all bot commands use the `$` prefix)
- `$announce [color] <message>` (mod+) — Helix chat announcement (colors: blue, green, orange, purple)
- `$bot join|leave <channel>` (superadmin, home channel only) — join/part channels
- `$raiders` / `$raids` — tonight's raiders for this channel (tracked per stream)
- `$so <username>` (mod+) — shoutout: orange announcement with last game + bio, `/me` fallback
- `$autoso <add|del|list> [@username]` (mod+) — auto-shoutout friends; friends get an automatic shoutout on their first chat each stream
- `$ending` / `$wrapup` / `$raidout` (mod+) — end-of-stream flow: sends `!raid`, `!subraid`, posts the raiders summary, and pings the Discord webhook (if configured)

Optional integrations (env vars, all off unless set): `DISCORD_WEBHOOK_URL` for the `$ending` raiders post; `GOOGLE_FORM_ID` + `FORM_ENTRY_*` to log incoming raids to a Google Sheet; `GOOGLE_FORM_ID_OUT` + `FORM_ENTRY_OUT_*` for outgoing raids.

Custom command responses support `${user}`, `${touser}`, `${channel}`, `${query}`, `${1}..${N}`, `${random.1-100}`, `${weather [location]}`, and `${customapi <url>}`.

## Automations (trigger → conditions → actions)

Streamer.bot-style flows, managed from the dashboard's Automations section. Each automation has a **trigger**, optional **conditions**, and an ordered list of **actions**.

**Triggers**
- `Keyword in chat` — message contains / equals / starts with some text (case-insensitive)
- `Regex match` — message matches a pattern (optional `i` flag)
- `Chat command` — someone uses `$name` (fires alongside any custom command of the same name)
- `Timer` — every N seconds (min 30), optionally requiring M chat messages of activity between fires; needs a specific channel
- `Incoming raid` — someone raids this channel (EventSub; works in any joined channel, no extra scopes). Variables: `${raider}` (login), `${raider_name}` (display name), `${viewers}`. The raider counts as the "user" for conditions/cooldowns.
- `Outgoing raid` — this channel raids someone else (EventSub). Variables: `${raid_target}` (login), `${raid_target_name}` (display name), `${viewers}`.

**Conditions** (message triggers only; all must pass)
- Minimum user level (everyone → superadmin)
- Only / never these users

**Actions** (run in order)
- `Send chat message` — variables supported (`${user}`, `${touser}`, …)
- `Send announcement` — bot must be a mod in the channel
- `Wait` — pause between actions (up to 60s)

Cooldowns: per-automation (everyone) and per-user. Automation fires are logged to the live log. The bot ignores its own messages, so automation output can't trigger other automations.
