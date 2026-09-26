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
import { startDashboard } from './dashboard.js';

dotenv.config();

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TOKEN_PATH = path.join(process.cwd(), 'data', 'tokens.json');

const SUPER_ADMINS = (process.env.SUPER_ADMINS || 'ronson,cyberpupbot').toLowerCase().split(',');
const HOME_CHANNELS = (process.env.HOME_CHANNELS || 'cyberpupbot').toLowerCase().split(',');

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

    // Trigger → Conditions → Actions engine. io.* abstracts Twurple so the
    // engine stays testable; closures run after connect, so referencing
    // chatClient/apiClient here is safe.
    const engine = createAutomationEngine({ db, parseVariables, logEvent });
    const automationIo = {
        say: (channel, text) => chatClient.say(channel, text),
        announce: async (cleanChannel, color, text) => {
            const broadcaster = await apiClient.users.getUserByName(cleanChannel);
            if (!broadcaster) throw new Error(`Couldn't find channel #${cleanChannel}.`);
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
    // channel.raid needs no OAuth scopes, so the bot's existing token works
    // for every joined channel, even where it is only a moderator.
    const eventSub = new EventSubWsListener({ apiClient });
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
    } catch (e) {
        console.warn('[EventSub] Failed to start listener:', e?.message || e);
    }

    chatClient.onMessage(async (channel, user, text, msg) => {
        const cleanChannel = channel.replace('#', '').toLowerCase();
        const cleanUser = user.toLowerCase();

        // Ignore our own messages (announcements arrive back as chat messages from us)
        if (botUserId && msg.userInfo.userId === botUserId) return;

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
        // TIER 2: STREAMELEMENTS STYLE COMMAND MANAGEMENT ($cmd)
        // -------------------------------------------------------------
        if (text.startsWith('$cmd ') && isModOrBroadcaster) {
            const args = text.slice(5).trim().split(/\s+/);
            const subCommand = args.shift()?.toLowerCase();
            const trigger = args.shift()?.toLowerCase().replace(/^[\$!]/, '');

            if (!subCommand || !trigger) {
                return chatClient.say(channel, 'Usage: $cmd <add|edit|delete|options> !<trigger> [args]');
            }

            // $cmd add !command response...
            if (subCommand === 'add' || subCommand === 'create') {
                const response = args.join(' ');
                if (!response) return chatClient.say(channel, `Usage: $cmd ${subCommand} !${trigger} <response>`);

                try {
                    db.prepare(`
            INSERT INTO commands (channel, trigger, response) VALUES (?, ?, ?)
          `).run(cleanChannel, trigger, response);
                    logEvent('command', `!${trigger} added in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Successfully created command !${trigger}`);
                } catch (err) {
                    return chatClient.say(channel, `Command !${trigger} already exists. Use $cmd edit to modify it.`);
                }
            }

            // $cmd edit !command response...
            if (subCommand === 'edit') {
                const response = args.join(' ');
                if (!response) return chatClient.say(channel, `Usage: $cmd edit !${trigger} <new response>`);

                const res = db.prepare('UPDATE commands SET response = ? WHERE channel = ? AND trigger = ?')
                    .run(response, cleanChannel, trigger);

                if (res.changes > 0) {
                    logEvent('command', `!${trigger} edited in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Updated response for !${trigger}`);
                } else {
                    return chatClient.say(channel, `Command !${trigger} does not exist.`);
                }
            }

            // $cmd show !command or $cmd info !command
            if (subCommand === 'show' || subCommand === 'info') {
                const cmd = db.prepare('SELECT * FROM commands WHERE LOWER(channel) = LOWER(?) AND LOWER(trigger) = LOWER(?)')
                    .get(cleanChannel, trigger);

                if (!cmd) {
                    return chatClient.say(channel, `Command !${trigger} does not exist.`);
                }

                // Map permission integer back to human-readable string
                const levelName = Object.keys(PERMISSIONS).find(key => PERMISSIONS[key] === cmd.userlevel) || 'everyone';

                return chatClient.say(
                    channel,
                    `Command !${cmd.trigger} -> Response: "${cmd.response}" | Level: ${levelName} (${cmd.userlevel}) | Cooldown: ${cmd.cooldown}s`
                );
            }

            // $cmd delete !command
            if (subCommand === 'delete' || subCommand === 'remove') {
                const res = db.prepare('DELETE FROM commands WHERE channel = ? AND trigger = ?')
                    .run(cleanChannel, trigger);

                if (res.changes > 0) {
                    logEvent('command', `!${trigger} deleted in #${cleanChannel} by ${user}`);
                    return chatClient.say(channel, `Deleted command !${trigger}`);
                } else {
                    return chatClient.say(channel, `Command !${trigger} not found.`);
                }
            }

            // $cmd options !command <userlevel|cooldown> <value>
            if (subCommand === 'options') {
                const property = args.shift()?.toLowerCase();
                const value = args.shift()?.toLowerCase();

                if (!property || !value) {
                    return chatClient.say(channel, `Usage: $cmd options !${trigger} <userlevel|cooldown> <value>`);
                }

                if (property === 'userlevel') {
                    if (!PERMISSIONS.hasOwnProperty(value)) {
                        return chatClient.say(channel, `Invalid level. Valid: ${Object.keys(PERMISSIONS).join(', ')}`);
                    }
                    db.prepare('UPDATE commands SET userlevel = ? WHERE channel = ? AND trigger = ?')
                        .run(PERMISSIONS[value], cleanChannel, trigger);
                    logEvent('command', `!${trigger} level -> ${value} in #${cleanChannel} (by ${user})`);
                    return chatClient.say(channel, `Set userlevel for !${trigger} to ${value}`);
                }

                if (property === 'cooldown') {
                    const seconds = parseInt(value, 10);
                    if (isNaN(seconds)) return chatClient.say(channel, 'Cooldown must be a number in seconds.');
                    db.prepare('UPDATE commands SET cooldown = ? WHERE channel = ? AND trigger = ?')
                        .run(seconds, cleanChannel, trigger);
                    logEvent('command', `!${trigger} cooldown -> ${seconds}s in #${cleanChannel} (by ${user})`);
                    return chatClient.say(channel, `Set cooldown for !${trigger} to ${seconds}s`);
                }
            }
            return;
        }

        // -------------------------------------------------------------
        // AUTOMATIONS: trigger → conditions → actions
        // Runs for every non-management message (fire-and-forget so action
        // delays never block command responses). The bot's own messages are
        // already filtered above, so automation output can't loop.
        // -------------------------------------------------------------
        {
            const words = text.trim().split(/\s+/);
            const commandName = (text.startsWith('!') || text.startsWith('$'))
                ? words[0].slice(1).toLowerCase().replace(/^[$!]/, '') || null
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
        if (!text.startsWith('$') && !text.startsWith('!')) return;
        const cmdArgs = text.slice(1).trim().split(/\s+/);
        const trigger = cmdArgs.shift().toLowerCase().replace(/^[\$!]/, '');

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
            logEvent('command', `!${trigger} by ${user} in #${cleanChannel}`);

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
    logEvent('bot', 'Connected to Twitch chat');

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