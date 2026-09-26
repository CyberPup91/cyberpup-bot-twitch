import { RefreshingAuthProvider } from '@twurple/auth';
import { ChatClient } from '@twurple/chat';
import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import db from './db.js';
import { parseAnnounceArgs } from './announce.js';
import { parseVariables } from './variables.js';
import { createAutomationEngine } from './automations.js';
import { logEvent } from './log.js';
import { noteOwnMessage, isOwnEcho } from './echoRegistry.js';
import { startDashboard } from './dashboard.js';
import {
    getActiveStreamId,
    recordRaid,
    getRaidersText,
    getStreamInfo,
    buildShoutout,
    announceOrFallback,
    addAutoSoFriend,
    removeAutoSoFriend,
    getAutoSoFriends,
    isAutoSoFriend,
    hasBeenAutoShoutedOut,
    recordAutoShoutout,
    logRaidToSheet,
    postDiscordRaiders,
} from './raids.js';

dotenv.config();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TOKEN_PATH = path.join(process.cwd(), 'data', 'tokens.json');

const SUPER_ADMINS = (process.env.SUPER_ADMINS || 'ronson,cyberpupbot').toLowerCase().split(',');
const HOME_CHANNELS = (process.env.HOME_CHANNELS || 'cyberpupbot').toLowerCase().split(',');

// Never die silently: surface unhandled promise rejections in the dashboard
// log (and keep the process alive) instead of crashing the container.
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    console.error('[Fatal] Unhandled rejection:', msg);
    try { logEvent('error', `Unhandled rejection: ${msg}`); } catch { /* ignore */ }
});
process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    console.error('[Fatal] Uncaught exception:', msg);
    try { logEvent('error', `Uncaught exception: ${msg}`); } catch { /* ignore */ }
});

// User Level Hierarchy
const PERMISSIONS = {
    everyone: 0,
    subscriber: 1,
    moderator: 2,
    broadcaster: 3,
    superadmin: 4
};

async function main() {
    const startedAt = Date.now();
    let tokenData;
    try {
        const raw = await fs.readFile(TOKEN_PATH, 'utf-8');
        tokenData = JSON.parse(raw);
    } catch (e) {
        tokenData = {
            accessToken: process.env.INITIAL_ACCESS_TOKEN || '',
            refreshToken: process.env.INITIAL_REFRESH_TOKEN || '',
            expiresIn: 0,
            obtainmentTimestamp: 0
        };
    }

    const authProvider = new RefreshingAuthProvider({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
    });

    authProvider.onRefresh(async (userId, newTokenData) => {
        await fs.writeFile(TOKEN_PATH, JSON.stringify(newTokenData, null, 2), 'utf-8');
        console.log('[Auth] Refreshed access token saved to disk.');
    });

    // addUserForToken validates the token and returns its owner's user ID.
    // (The second arg is intents, not scopes — the announce scope only needs
    // to be granted on the token itself at OAuth time.)
    const botUserId = await authProvider.addUserForToken(tokenData, ['chat']);

    const apiClient = new ApiClient({ authProvider });

    // Resolve our display name for the dashboard. The user ID above is
    // authoritative, so this lookup is cosmetic-only: if it fails, the
    // dashboard shows "unknown" but the self-message guard still works.
    let botDisplayName = 'unknown';
    try {
        const me = await apiClient.users.getUserById(botUserId);
        if (me) {
            botDisplayName = me.displayName;
            console.log(`[Bot] Authenticated as ${me.displayName} (${botUserId})`);
            logEvent('bot', `Authenticated as ${me.displayName}`);
        }
    } catch (e) {
        console.warn(`[Bot] Could not fetch bot display name: ${e.message}`);
    }

    // Load channels
    const rows = db.prepare('SELECT name FROM channels').all();
    let channelsToJoin = rows.map(r => r.name);
    if (channelsToJoin.length === 0) {
        channelsToJoin = ['cyberpupbot'];
        db.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').run('cyberpupbot');
    }

    const chatClient = new ChatClient({ authProvider, channels: channelsToJoin });

    // ------------------------------------------------------------------
    // Own-output echo registry (see src/echoRegistry.js).
    // The bot runs on Ronson's main account: incoming messages from the
    // bot's own user ID are usually Ronson typing himself and MUST be
    // processed — only echoes of the bot's own recent output are dropped
    // (loop protection). Wrap say/action so EVERY outgoing chat message
    // is echo-registered, no matter which call site sends it.
    // ------------------------------------------------------------------
    const _botSay = chatClient.say.bind(chatClient);
    chatClient.say = (...args) => { noteOwnMessage(args[1]); return _botSay(...args); };
    const _botAction = chatClient.action.bind(chatClient);
    chatClient.action = (...args) => { noteOwnMessage(args[1]); return _botAction(...args); };

    // Trigger → Conditions → Actions engine. io.* abstracts Twurple so the
    // engine stays testable; closures run after connect, so referencing
    // chatClient/apiClient here is safe.
    const engine = createAutomationEngine({ db, parseVariables, logEvent });
    const automationIo = {
        say: (channel, text) => chatClient.say(channel, text),
        announce: async (cleanChannel, color, text) => {
            const broadcaster = await apiClient.users.getUserByName(cleanChannel);
            if (!broadcaster) throw new Error(`Couldn't find channel #${cleanChannel}.`);
            noteOwnMessage(text); // register before send so the echo is dropped
            await apiClient.asUser(botUserId, async (ctx) => {
                await ctx.chat.sendAnnouncement(broadcaster.id, {
                    message: text.slice(0, 500),
                    color
                });
            });
        },
        isJoined: (cleanChannel) => {
            const cur = chatClient.currentChannels;
            if (!Array.isArray(cur)) return true;
            return cur.some((c) => c.replace(/^#/, '').toLowerCase() === cleanChannel);
        }
    };

    // ---- EventSub (raids) -------------------------------------------------
    // channel.raid needs no OAuth scope, so the bot's existing token works
    // for every joined channel, even where it is only a moderator.
    //
    // Twurple quirk: EventSubChannelRaidSubscription hardcodes authUserId to
    // the *broadcaster* being monitored, so subscription creation tries to
    // use the broadcaster's token (which we don't have) and fails with
    // "no token was found". Twitch itself accepts these subscriptions from
    // any user token (the Python bot does exactly that), so we override the
    // subscription to use the bot's own user context instead. Without this,
    // no subscription is ever created, Twitch closes the socket with
    // [4003] connection unused after 10s, and it reconnect-loops forever.
    class BotEventSubListener extends EventSubWsListener {
        _genericSubscribe(clazz, handler, client, ...params) {
            if (!clazz.prototype.__botAuthPatched) {
                const botId = this.__botUserId;
                // 1) Route the socket + transport through the bot's user
                //    context instead of the broadcaster's.
                Object.defineProperty(clazz.prototype, 'authUserId', {
                    get() { return botId; },
                    configurable: true
                });
                // 2) createSubscription() is also called with the broadcaster
                //    as the user context (HelixEventSubApi passes it through),
                //    so reimplement _subscribe with the bot as the user.
                //    The condition still targets the broadcaster — Twitch
                //    accepts channel.raid subscriptions from any user token.
                clazz.prototype._subscribe = async function () {
                    const transport = await this._getTransportOptions();
                    const conditionKey = this._direction === 'from'
                        ? 'from_broadcaster_user_id'
                        : 'to_broadcaster_user_id';
                    return await this._client._apiClient.eventSub.createSubscription(
                        'channel.raid',
                        '1',
                        { [conditionKey]: this._userId },
                        transport,
                        botId
                    );
                };
                Object.defineProperty(clazz.prototype, '__botAuthPatched', {
                    value: true, configurable: true
                });
            }
            return super._genericSubscribe(clazz, handler, client, ...params);
        }
    }
    //
    // keepalive_timeout_seconds=60: Twitch's default 10s keepalive window is
    // prone to spurious client-side timeouts (twurple/twurple#666). 60s
    // (client times out at 72s) is far more tolerant of network jitter.
    const eventSub = new BotEventSubListener({
        apiClient,
        url: 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=60'
    });
    eventSub.__botUserId = botUserId;
    const raidSubs = new Map(); // cleanChannel -> EventSubSubscription[]

    function handleRaidEvent(direction, event) {
        const viewers = event.viewers ?? 0;
        let ctx;
        if (direction === 'raid_incoming') {
            const raider = (event.raidingBroadcasterName || '').toLowerCase();
            const cleanChannel = (event.raidedBroadcasterName || '').toLowerCase();
            ctx = {
                channel: `#${cleanChannel}`, cleanChannel,
                user: raider, cleanUser: raider, userLevel: PERMISSIONS.everyone,
                text: '', args: [], commandName: null,
                eventType: 'raid_incoming',
                extra: {
                    raider,
                    raider_name: event.raidingBroadcasterDisplayName || raider,
                    viewers
                }
            };
        } else {
            const target = (event.raidedBroadcasterName || '').toLowerCase();
            const cleanChannel = (event.raidingBroadcasterName || '').toLowerCase();
            ctx = {
                channel: `#${cleanChannel}`, cleanChannel,
                user: '', cleanUser: '', userLevel: PERMISSIONS.everyone,
                text: '', args: [], commandName: null,
                eventType: 'raid_outgoing',
                extra: {
                    raid_target: target,
                    raid_target_name: event.raidedBroadcasterDisplayName || target,
                    viewers
                }
            };
        }
        logEvent('eventsub', `Raid ${direction === 'raid_incoming' ? 'in' : 'out'}: #${ctx.cleanChannel} (${viewers} viewers)`);
        if (direction === 'raid_incoming') {
            // Background integrations (Python parity): record for $raiders
            // and log to Google Sheets. Shoutout/welcome messages are left
            // to the user's raid_incoming automations.
            getActiveStreamId(apiClient, db, ctx.cleanChannel)
                .then((streamId) => {
                    recordRaid(db, ctx.cleanChannel, streamId, ctx.extra.raider, viewers);
                    logEvent('eventsub', `Recorded raid from ${ctx.extra.raider} (${viewers} viewers) in #${ctx.cleanChannel}`);
                })
                .catch((e) => console.warn('[EventSub] raid record failed:', e?.message || e));
            logRaidToSheet('in', ctx.extra.raider, viewers, logEvent);
        } else {
            logRaidToSheet('out', ctx.extra.raid_target, viewers, logEvent);
        }
        engine.processEvent(ctx, automationIo).catch((e) => console.warn('[EventSub]', e?.message || e));
    }

    async function subscribeRaidEvents(channelName) {
        const clean = channelName.toLowerCase().replace(/^#/, '');
        if (raidSubs.has(clean)) return;
        try {
            const broadcaster = await apiClient.users.getUserByName(clean);
            if (!broadcaster) {
                console.warn(`[EventSub] Couldn't resolve #${clean}, skipping raid subscriptions.`);
                return;
            }
            const subs = [
                eventSub.onChannelRaidTo(broadcaster.id, (e) => handleRaidEvent('raid_incoming', e)),
                eventSub.onChannelRaidFrom(broadcaster.id, (e) => handleRaidEvent('raid_outgoing', e)),
            ];
            raidSubs.set(clean, subs);
            console.log(`[EventSub] Raid detection active for #${clean}.`);
            logEvent('eventsub', `Raid detection active for #${clean}`);
        } catch (e) {
            console.warn(`[EventSub] Failed to subscribe raids for #${clean}: ${e?.message || e}`);
            logEvent('error', `EventSub subscribe failed for #${clean}: ${e?.message || e}`);
        }
    }

    function unsubscribeRaidEvents(channelName) {
        const clean = channelName.toLowerCase().replace(/^#/, '');
        for (const sub of raidSubs.get(clean) || []) {
            try { sub.stop(); } catch { /* ignore */ }
        }
        raidSubs.delete(clean);
    }

    try {
        eventSub.start();
        eventSub.onUserSocketConnect(() => {
            console.log('[EventSub] WebSocket connected.');
            logEvent('eventsub', 'WebSocket connected');
        });
        eventSub.onUserSocketDisconnect((userId, error) => {
            const reason = error?.message || error || 'no reason given';
            console.warn(`[EventSub] WebSocket disconnected: ${reason}`);
            logEvent('eventsub', `WebSocket disconnected: ${reason}`);
        });
    } catch (e) {
        console.warn('[EventSub] Failed to start listener:', e?.message || e);
    }

    // Surface chat connection drops in the dashboard log — a dead chat
    // connection means no commands respond, and otherwise it's invisible.
    chatClient.onDisconnect((manually, reason) => {
        const msg = `Chat disconnected${manually ? ' (manual)' : ''}: ${reason?.message || reason || 'no reason given'}`;
        console.warn(`[Chat] ${msg}`);
        logEvent('chat', msg);
    });
    // Twitch can reject our outgoing messages (ban, block, rate limit...).
    // Without this, sends fail silently and commands look dead.
    chatClient.onMessageFailed((channel, reason) => {
        const msg = `Message to #${channel} rejected by Twitch: ${reason}`;
        console.warn(`[Chat] ${msg}`);
        logEvent('chat', msg);
    });

    chatClient.onMessage(async (channel, user, text, msg) => {
        const cleanChannel = channel.replace('#', '').toLowerCase();
        const cleanUser = user.toLowerCase();

        // The bot runs on Ronson's own account: only drop messages that are
        // echoes of the bot's own recent output (say/action/announcement),
        // which Twitch sends back to chat — reprocessing those would loop.
        // Anything else from this account was typed by Ronson himself, so
        // process it normally (including $ commands).
        if (botUserId && msg.userInfo.userId === botUserId && isOwnEcho(text)) return;

        // Diagnostic: log incoming $ commands so we can tell "message never
        // arrived" apart from "response failed to send".
        if (text.startsWith('$')) {
            logEvent('chat', `Incoming: ${user} in #${cleanChannel}: ${text.slice(0, 120)}`);
        }

        const isSuperAdmin = SUPER_ADMINS.includes(cleanUser);
        const isModOrBroadcaster = msg.userInfo.isMod || msg.userInfo.isBroadcaster || isSuperAdmin;
        const isHomeChannel = HOME_CHANNELS.includes(cleanChannel);

        // Calculate User Level
        let userLevel = PERMISSIONS.everyone;
        if (msg.userInfo.isSubscriber) userLevel = PERMISSIONS.subscriber;
        if (msg.userInfo.isMod) userLevel = PERMISSIONS.moderator;
        if (msg.userInfo.isBroadcaster) userLevel = PERMISSIONS.broadcaster;
        if (isSuperAdmin) userLevel = PERMISSIONS.superadmin;

        // -------------------------------------------------------------
        // AUTO-SHOUTOUT: friend chatted and hasn't been shouted out
        // this stream -> orange announcement with game + bio.
        // (Fire-and-forget; never blocks command handling below.)
        // -------------------------------------------------------------
        if (isAutoSoFriend(db, cleanChannel, cleanUser)) {
            getActiveStreamId(apiClient, db, cleanChannel).then(async (streamId) => {
                if (!streamId || hasBeenAutoShoutedOut(db, cleanChannel, streamId, cleanUser)) return;
                recordAutoShoutout(db, cleanChannel, streamId, cleanUser);
                const info = await getStreamInfo(apiClient, cleanUser);
                const soMsg = buildShoutout(cleanUser, info.gameName, info.bio);
                await announceOrFallback(
                    { apiClient, botUserId, chatClient, logEvent, noteOwnMessage },
                    cleanChannel, soMsg, 'orange'
                );
                logEvent('bot', `Auto-shoutout for ${cleanUser} in #${cleanChannel}`);
            }).catch((e) => console.warn('[AutoSO]', e?.message || e));
        }

        // -------------------------------------------------------------
        // TIER 1: GLOBAL SUPER-ADMIN COMMANDS ($bot join / $bot leave)
        // -------------------------------------------------------------
        if (text.startsWith('$bot ') && isSuperAdmin && isHomeChannel) {
            const parts = text.slice(5).trim().split(/\s+/);
            const action = parts[0]?.toLowerCase();
            const target = parts[1]?.toLowerCase().replace('#', '');

            if (action === 'join' && target) {
                db.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').run(target);
                await chatClient.join(target);
                await subscribeRaidEvents(target);
                logEvent('channel', `Joined #${target} (requested by ${user})`);
                return chatClient.say(channel, `Joined #${target}!`);
            }
            if (action === 'leave' && target) {
                db.prepare('DELETE FROM channels WHERE name = ?').run(target);
                chatClient.part(target);
                unsubscribeRaidEvents(target);
                logEvent('channel', `Left #${target} (requested by ${user})`);
                return chatClient.say(channel, `Left #${target}.`);
            }
        }

        // -------------------------------------------------------------
        // TIER 1.5: ANNOUNCEMENTS ($announce)
        // Sends a Helix chat announcement. Requires the bot account to be
        // a moderator in the channel and the
        // moderator:manage:announcements scope on its token.
        // Usage: $announce [color] <message>
        // Colors: blue, green, orange, purple (default: primary)
        // -------------------------------------------------------------
        if (text.startsWith('$announce ') && isModOrBroadcaster) {
            const { color, message } = parseAnnounceArgs(text);

            if (!message) {
                return chatClient.say(channel, 'Usage: $announce [color] <message> (colors: blue, green, orange, purple)');
            }

            try {
                const broadcaster = await apiClient.users.getUserByName(cleanChannel);
                if (!broadcaster) {
                    return chatClient.say(channel, `Couldn't find channel #${cleanChannel}.`);
                }
                // Run in the bot's user context so Twurple sends
                // moderator_id=<bot> (not the broadcaster) and picks the
                // bot's token, which carries moderator:manage:announcements.
                noteOwnMessage(message); // register before send so the echo is dropped
                await apiClient.asUser(botUserId, async (ctx) => {
                    await ctx.chat.sendAnnouncement(broadcaster.id, {
                        message: message.slice(0, 500),
                        color
                    });
                });
                console.log(`[Announce] #${cleanChannel} (${color}): ${message}`);
                logEvent('announce', `#${cleanChannel} (${color}): ${message}`);
            } catch (e) {
                console.warn('[Announce] failed:', e?.message || e);
                logEvent('error', `Announce failed in #${cleanChannel}: ${e?.message || e}`);
                return chatClient.say(channel,
                    `Couldn't send that announcement -- is this account a mod in #${cleanChannel}?`);
            }
            return;
        }

        // -------------------------------------------------------------
        // TIER 1.6: RAID & SHOUTOUT COMMANDS (Python-bot parity)
        // $raiders / $so / $autoso / $ending — per channel.
        // -------------------------------------------------------------
        const lcText = text.toLowerCase();

        // $raiders / $raids (everyone): tonight's raiders for this channel.
        if (lcText === '$raiders' || lcText === '$raids') {
            const raidersText = getRaidersText(db, cleanChannel);
            if (!raidersText) {
                return chatClient.say(channel, 'No raids recorded this stream yet!');
            }
            return chatClient.say(channel,
                `Huge thanks to tonight's raiders! Check out their channels: ${raidersText}`.slice(0, 500));
        }

        if (isModOrBroadcaster) {
            // $so <username>: orange announcement shoutout with last game + bio.
            if (lcText.startsWith('$so ') || lcText === '$so') {
                const target = text.slice(3).trim().split(/\s+/)[0]?.toLowerCase().replace(/^@/, '');
                if (!target) {
                    return chatClient.say(channel, 'Usage: $so <username>');
                }
                const info = await getStreamInfo(apiClient, target);
                const soMsg = buildShoutout(target, info.gameName, info.bio);
                await announceOrFallback(
                    { apiClient, botUserId, chatClient, logEvent, noteOwnMessage },
                    cleanChannel, soMsg, 'orange'
                );
                logEvent('bot', `$so for ${target} in #${cleanChannel}`);
                return;
            }

            // $autoso <add|del|list> [@username]: auto-shoutout friends.
            if (lcText.startsWith('$autoso')) {
                const args = text.slice(7).trim().split(/\s+/).filter(Boolean);
                const sub = (args[0] || '').toLowerCase();
                if (sub === 'list' || !sub) {
                    const friends = getAutoSoFriends(db, cleanChannel);
                    return chatClient.say(channel, friends.length
                        ? `Auto-shoutout friends: ${friends.join(', ')}`
                        : 'No friends configured for auto-shoutouts yet!');
                }
                if (sub === 'add' || sub === 'append') {
                    const target = (args[1] || '').toLowerCase().replace(/^@/, '');
                    if (!target) return chatClient.say(channel, 'Usage: $autoso add @username');
                    addAutoSoFriend(db, cleanChannel, target, cleanUser);
                    return chatClient.say(channel, `Added ${target} to the auto-shoutout friends list!`);
                }
                if (sub === 'del' || sub === 'delete' || sub === 'remove') {
                    const target = (args[1] || '').toLowerCase().replace(/^@/, '');
                    if (!target) return chatClient.say(channel, 'Usage: $autoso del @username');
                    const removed = removeAutoSoFriend(db, cleanChannel, target);
                    return chatClient.say(channel, removed
                        ? `Removed ${target} from the auto-shoutout friends list!`
                        : `${target} wasn't on the auto-shoutout list.`);
                }
                return chatClient.say(channel, 'Usage: $autoso <add|del|list> [@username]');
            }

            // $ending / $wrapup / $raidout: end-of-stream raid-out flow.
            if (lcText === '$ending' || lcText === '$wrapup' || lcText === '$raidout') {
                await chatClient.say(channel, '!raid');
                await new Promise((r) => setTimeout(r, 3000));
                await chatClient.say(channel, '!subraid');
                await new Promise((r) => setTimeout(r, 3000));
                const raidersText = getRaidersText(db, cleanChannel);
                if (raidersText) {
                    await chatClient.say(channel,
                        `Huge thanks to tonight's raiders! Check out their channels: ${raidersText}`.slice(0, 500));
                } else {
                    await chatClient.say(channel, 'No raids recorded this stream yet!');
                }
                await postDiscordRaiders(db, cleanChannel, logEvent);
                logEvent('bot', `$ending flow ran in #${cleanChannel}`);
                return;
            }
        }

        // -------------------------------------------------------------
        // TIER 2: STREAMELEMENTS STYLE COMMAND MANAGEMENT ($cmd)
        // -------------------------------------------------------------
        if (text.startsWith('$cmd ') && isModOrBroadcaster) {
            const args = text.slice(5).trim().split(/\s+/);
            const subCommand = args.shift()?.toLowerCase();
            const trigger = args.shift()?.toLowerCase().replace(/^[\$!]/, '');

            if (!subCommand || !trigger) {
                return chatClient.say(channel, 'Usage: $cmd <add|edit|delete|options> $<trigger> [args]');
            }

            // $cmd add !command response...
            if (subCommand === 'add' || subCommand === 'create') {
                const response = args.join(' ');
                if (!response) return chatClient.say(channel, `Usage: $cmd ${subCommand} $${trigger} <response>`);

                try {
                    db.prepare(`
            INSERT INTO commands (channel, trigger, response) VALUES (?, ?, ?)
          `).run(cleanChannel, trigger, response);
                    logEvent('command', `$${trigger} added in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Successfully created command $${trigger}`);
                } catch (err) {
                    return chatClient.say(channel, `Command $${trigger} already exists. Use $cmd edit to modify it.`);
                }
            }

            // $cmd edit !command response...
            if (subCommand === 'edit') {
                const response = args.join(' ');
                if (!response) return chatClient.say(channel, `Usage: $cmd edit $${trigger} <new response>`);

                const res = db.prepare('UPDATE commands SET response = ? WHERE channel = ? AND trigger = ?')
                    .run(response, cleanChannel, trigger);

                if (res.changes > 0) {
                    logEvent('command', `$${trigger} edited in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Updated response for $${trigger}`);
                } else {
                    return chatClient.say(channel, `Command $${trigger} does not exist.`);
                }
            }

            // $cmd show !command or $cmd info !command
            if (subCommand === 'show' || subCommand === 'info') {
                const cmd = db.prepare('SELECT * FROM commands WHERE LOWER(channel) = LOWER(?) AND LOWER(trigger) = LOWER(?)')
                    .get(cleanChannel, trigger);

                if (!cmd) {
                    return chatClient.say(channel, `Command $${trigger} does not exist.`);
                }

                // Map permission integer back to human-readable string
                const levelName = Object.keys(PERMISSIONS).find(key => PERMISSIONS[key] === cmd.userlevel) || 'everyone';

                return chatClient.say(
                    channel,
                    `Command $${cmd.trigger} -> Response: "${cmd.response}" | Level: ${levelName} (${cmd.userlevel}) | Cooldown: ${cmd.cooldown}s`
                );
            }

            // $cmd delete !command
            if (subCommand === 'delete' || subCommand === 'remove') {
                const res = db.prepare('DELETE FROM commands WHERE channel = ? AND trigger = ?')
                    .run(cleanChannel, trigger);

                if (res.changes > 0) {
                    logEvent('command', `$${trigger} deleted in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Deleted command $${trigger}`);
                } else {
                    return chatClient.say(channel, `Command $${trigger} not found.`);
                }
            }

            // $cmd options !command <userlevel|cooldown> <value>
            if (subCommand === 'options') {
                const property = args.shift()?.toLowerCase();
                const value = args.shift()?.toLowerCase();

                if (!property || !value) {
                    return chatClient.say(channel, `Usage: $cmd options $${trigger} <userlevel|cooldown> <value>`);
                }

                if (property === 'userlevel') {
                    if (!PERMISSIONS.hasOwnProperty(value)) {
                        return chatClient.say(channel, `Invalid level. Valid: ${Object.keys(PERMISSIONS).join(', ')}`);
                    }
                    db.prepare('UPDATE commands SET userlevel = ? WHERE channel = ? AND trigger = ?')
                        .run(PERMISSIONS[value], cleanChannel, trigger);
                    logEvent('command', `$${trigger} level -> ${value} in #${cleanChannel} (by ${user})`);
                    return chatClient.say(channel, `Set userlevel for $${trigger} to ${value}`);
                }

                if (property === 'cooldown') {
                    const seconds = parseInt(value, 10);
                    if (isNaN(seconds)) return chatClient.say(channel, 'Cooldown must be a number in seconds.');
                    db.prepare('UPDATE commands SET cooldown = ? WHERE channel = ? AND trigger = ?')
                        .run(seconds, cleanChannel, trigger);
                    logEvent('command', `$${trigger} cooldown -> ${seconds}s in #${cleanChannel} (by ${user})`);
                    return chatClient.say(channel, `Set cooldown for $${trigger} to ${seconds}s`);
                }
            }
            return;
        }

        // -------------------------------------------------------------
        // AUTOMATIONS: trigger → conditions → actions
        // Runs for every non-management message (fire-and-forget so action
        // delays never block command responses). Echoes of the bot's own
        // output are already filtered above via the echo registry, so
        // automation output can't loop.
        // -------------------------------------------------------------
        {
            const words = text.trim().split(/\s+/);
            const commandName = text.startsWith('$')
                ? words[0].slice(1).toLowerCase().replace(/^\$/, '') || null
                : null;
            engine.processMessage({
                channel,
                cleanChannel,
                user,
                cleanUser,
                userLevel,
                text,
                args: commandName ? words.slice(1) : words,
                commandName
            }, automationIo).catch((e) => console.warn('[Automations]', e?.message || e));
        }

        // -------------------------------------------------------------
        // GENERAL CHAT COMMAND EXECUTION
        // -------------------------------------------------------------
        if (!text.startsWith('$')) return;
        const cmdArgs = text.slice(1).trim().split(/\s+/);
        const trigger = cmdArgs.shift().toLowerCase().replace(/^\$/, '');

        // Force lower-case lookup for both channel and trigger to prevent SQLite case-mismatches
        const cmd = db.prepare('SELECT * FROM commands WHERE LOWER(channel) = LOWER(?) AND LOWER(trigger) = LOWER(?)')
            .get(cleanChannel, trigger);

        if (cmd) {
            const cmdLevel = cmd.userlevel ?? 0;
            const cmdCooldown = cmd.cooldown ?? 5;
            const lastUsed = cmd.last_used ?? 0;

            if (userLevel < cmdLevel && !isSuperAdmin) return;

            const now = Math.floor(Date.now() / 1000);
            if (lastUsed > 0 && (now - lastUsed) < cmdCooldown) return;

            db.prepare('UPDATE commands SET last_used = ? WHERE id = ?').run(now, cmd.id);
            logEvent('command', `$${trigger} by ${user} in #${cleanChannel}`);

            // Parse all variables asynchronously
            const response = await parseVariables(cmd.response || '', {
                user,
                channel: cleanChannel,
                args: cmdArgs
            });

            if (response) {
                chatClient.say(channel, response);
            }
        }
    });

    // Web dashboard: runs in this process and shares the DB, so dashboard
    // changes (commands, channels) take effect immediately, no restart needed.
    try {
        startDashboard({
            db,
            chatClient,
            info: { botName: botDisplayName, startedAt },
            port: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
            host: process.env.DASHBOARD_HOST || '127.0.0.1',
            eventHooks: { subscribe: subscribeRaidEvents, unsubscribe: unsubscribeRaidEvents }
        });
    } catch (e) {
        console.warn('[Dashboard] Failed to start:', e.message);
    }

    await chatClient.connect();
    console.log('[Bot] CyberPupBot connected to Twitch Chat.');
    logEvent('bot', `Connected to Twitch chat (channels: ${channelsToJoin.join(', ') || 'none'})`);

    // EventSub raid subscriptions for every joined channel.
    for (const ch of channelsToJoin) {
        await subscribeRaidEvents(ch);
    }

    // Automation timers (timer trigger type), evaluated every 15s.
    setInterval(() => {
        engine.processTimers(automationIo).catch((e) => console.warn('[Automations] timer tick:', e?.message || e));
    }, 15000);
}

main().catch(console.error);