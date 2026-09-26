// Raid tracking, stream sessions, shoutouts, and external logging.
// Mirrors the Python bot's raid/stream/Discord/Sheets behavior, adapted for
// multi-channel use. All functions take `db` explicitly so they stay testable.

const streamCheckCache = new Map(); // channel -> { streamId, checkedAt }
const STREAM_CHECK_TTL_MS = 60_000; // like the Python bot's 60s monitor poll

function cleanChannel(name) {
    return String(name || '').toLowerCase().replace(/^#/, '').trim();
}

// Returns the active stream ID for a channel, or the last known one if the
// channel is offline (null if never seen live). Cached for 60s per channel.
export async function getActiveStreamId(apiClient, db, channel) {
    channel = cleanChannel(channel);
    const cached = streamCheckCache.get(channel);
    if (cached && Date.now() - cached.checkedAt < STREAM_CHECK_TTL_MS) {
        return cached.streamId;
    }
    let liveId = null;
    try {
        const stream = await apiClient.streams.getStreamByUserName(channel);
        liveId = stream?.id || null;
    } catch {
        liveId = null;
    }
    const stored = db.prepare('SELECT stream_id FROM channel_streams WHERE channel = ?').get(channel)?.stream_id || null;
    if (liveId && liveId !== stored) {
        // New stream: clear this channel's per-stream state, like the
        // Python bot's stream monitor does.
        db.prepare('DELETE FROM raids WHERE channel = ?').run(channel);
        db.prepare('DELETE FROM autoso_log WHERE channel = ?').run(channel);
        db.prepare('INSERT OR REPLACE INTO channel_streams (channel, stream_id) VALUES (?, ?)').run(channel, liveId);
        streamCheckCache.set(channel, { streamId: liveId, checkedAt: Date.now() });
        return liveId;
    }
    const result = liveId || stored;
    streamCheckCache.set(channel, { streamId: result, checkedAt: Date.now() });
    return result;
}

export function recordRaid(db, channel, streamId, raiderLogin, viewers) {
    db.prepare(
        'INSERT INTO raids (channel, stream_id, raider_login, viewers) VALUES (?, ?, ?, ?)'
    ).run(cleanChannel(channel), streamId, String(raiderLogin || '').toLowerCase(), viewers | 0);
}

// "raider (N viewers) - https://twitch.tv/raider, ..." or null when empty.
export function getRaidersText(db, channel) {
    const rows = db.prepare(
        'SELECT raider_login, viewers FROM raids WHERE channel = ? ORDER BY created_at'
    ).all(cleanChannel(channel));
    if (!rows.length) return null;
    return rows
        .map((r) => `${r.raider_login} (${r.viewers} viewers) - https://twitch.tv/${r.raider_login}`)
        .join(', ');
}

export function getRaiderCount(db, channel) {
    return db.prepare('SELECT COUNT(*) AS n FROM raids WHERE channel = ?').get(cleanChannel(channel))?.n || 0;
}

// --- shoutouts -------------------------------------------------------------

// { userId, gameName, bio } — gameName defaults to 'Variety' like the Python bot.
export async function getStreamInfo(apiClient, username) {
    const login = String(username || '').toLowerCase().replace(/^@/, '').trim();
    try {
        const user = await apiClient.users.getUserByName(login);
        if (!user) return { userId: null, gameName: 'Variety', bio: '' };
        let gameName = 'Variety';
        try {
            const info = await apiClient.channels.getChannelInfoById(user.id);
            gameName = info?.gameName || 'Variety';
        } catch { /* keep default */ }
        return { userId: user.id, gameName, bio: user.description || '' };
    } catch {
        return { userId: null, gameName: 'Variety', bio: '' };
    }
}

// Exact message format from the Python bot's $so / raid shoutouts.
export function buildShoutout(login, gameName, bio) {
    const cleanBio = bio ? ` Bio: ${bio.slice(0, 120)}...` : '';
    return `Check out ${login}, last seen playing ${gameName} 🍞 Go follow: https://twitch.tv/${login} 🍞 ${cleanBio}`;
}

// Try a real announcement; fall back to a /me chat message (bot badge).
// Returns 'announce' | 'chat'.
export async function announceOrFallback({ apiClient, botUserId, chatClient, logEvent }, channel, text, color = 'orange') {
    const clean = cleanChannel(channel);
    try {
        const broadcaster = await apiClient.users.getUserByName(clean);
        if (!broadcaster) throw new Error('channel not found');
        await apiClient.asUser(botUserId, async (ctx) => {
            await ctx.chat.sendAnnouncement(broadcaster.id, { message: text.slice(0, 500), color });
        });
        return 'announce';
    } catch (e) {
        logEvent?.('bot', `Announcement failed in #${clean}, falling back to chat: ${e?.message || e}`);
        await chatClient.action('#' + clean, `⭐ ${text}`);
        return 'chat';
    }
}

// --- auto-shoutout friends -------------------------------------------------

export function addAutoSoFriend(db, channel, username, addedBy) {
    channel = cleanChannel(channel);
    username = String(username || '').toLowerCase().replace(/^@/, '').trim();
    if (!username) return false;
    db.prepare('INSERT OR IGNORE INTO autoso_friends (channel, username, added_by) VALUES (?, ?, ?)')
        .run(channel, username, addedBy || null);
    return true;
}

export function removeAutoSoFriend(db, channel, username) {
    const r = db.prepare('DELETE FROM autoso_friends WHERE channel = ? AND username = ?')
        .run(cleanChannel(channel), String(username || '').toLowerCase().replace(/^@/, '').trim());
    return r.changes > 0;
}

export function getAutoSoFriends(db, channel) {
    return db.prepare('SELECT username FROM autoso_friends WHERE channel = ? ORDER BY username')
        .all(cleanChannel(channel)).map((r) => r.username);
}

export function isAutoSoFriend(db, channel, username) {
    return !!db.prepare('SELECT 1 FROM autoso_friends WHERE channel = ? AND username = ?')
        .get(cleanChannel(channel), String(username || '').toLowerCase());
}

export function hasBeenAutoShoutedOut(db, channel, streamId, username) {
    if (!streamId) return true; // no active stream -> don't fire
    return !!db.prepare('SELECT 1 FROM autoso_log WHERE channel = ? AND stream_id = ? AND username = ?')
        .get(cleanChannel(channel), streamId, String(username || '').toLowerCase());
}

export function recordAutoShoutout(db, channel, streamId, username) {
    db.prepare('INSERT OR IGNORE INTO autoso_log (channel, stream_id, username) VALUES (?, ?, ?)')
        .run(cleanChannel(channel), streamId, String(username || '').toLowerCase());
}

// --- external logging ------------------------------------------------------
// Both are no-ops unless the corresponding env vars are set.

export async function logRaidToSheet(direction, name, viewers, logEvent) {
    const isOut = direction === 'out';
    const formId = isOut ? process.env.GOOGLE_FORM_ID_OUT : process.env.GOOGLE_FORM_ID;
    if (!formId) return;
    const login = String(name || '').toLowerCase();
    const payload = isOut
        ? {
            [process.env.FORM_ENTRY_OUT_TARGET]: name,
            [process.env.FORM_ENTRY_OUT_VIEWERS]: String(viewers),
            [process.env.FORM_ENTRY_OUT_URL]: `https://twitch.tv/${login}`,
            [process.env.FORM_ENTRY_OUT_NOTES]: '',
        }
        : {
            [process.env.FORM_ENTRY_RAIDER_NAME]: name,
            [process.env.FORM_ENTRY_VIEWERS]: String(viewers),
            [process.env.FORM_ENTRY_TWITCH_URL]: `https://twitch.tv/${login}`,
            [process.env.FORM_ENTRY_NOTES]: '',
        };
    try {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(payload)) {
            if (k && k !== 'undefined') body.append(k, v ?? '');
        }
        const resp = await fetch(`https://docs.google.com/forms/d/e/${formId}/formResponse`, {
            method: 'POST',
            body,
        });
        logEvent?.('bot', `Google Sheet ${isOut ? 'outgoing' : 'incoming'} raid log: HTTP ${resp.status}`);
    } catch (e) {
        logEvent?.('error', `Google Sheet raid log failed: ${e?.message || e}`);
    }
}

export async function postDiscordRaiders(db, channel, logEvent) {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) return false;
    const rows = db.prepare('SELECT raider_login FROM raids WHERE channel = ? ORDER BY created_at')
        .all(cleanChannel(channel));
    if (!rows.length) return false;
    const content = `**Tonight's Raiders:**\n${rows.map((r) => `https://twitch.tv/${r.raider_login}`).join('\n')}`;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        logEvent?.('bot', `Discord raiders webhook: HTTP ${resp.status}`);
        return resp.ok;
    } catch (e) {
        logEvent?.('error', `Discord webhook failed: ${e?.message || e}`);
        return false;
    }
}

// Test helper: reset the 60s stream cache.
export function _resetStreamCache() {
    streamCheckCache.clear();
}
