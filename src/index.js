import { RefreshingAuthProvider } from '@twurple/auth';
import { ChatClient } from '@twurple/chat';
import { ApiClient } from '@twurple/api';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import db from './db.js';
import { parseAnnounceArgs } from './announce.js';

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

// ----------------------------------------------------
// DYNAMIC VARIABLE PARSER
// ----------------------------------------------------
async function parseVariables(template, context) {
    const { user, channel, args } = context;
    const touser = args[0] ? args[0].replace('@', '') : user;

    let text = template;

    // 1. Basic Identity & Argument Variables
    text = text.replace(/\${user}/g, user);
    text = text.replace(/\${channel}/g, channel);
    text = text.replace(/\${touser}/g, touser);
    text = text.replace(/\${query}/g, args.join(' ') || user);
    text = text.replace(/\${(\d+)}/g, (_, index) => args[parseInt(index, 10) - 1] || '');

    // 2. Random Number Generator: ${random.1-100}
    text = text.replace(/\${random\.(\d+)-(\d+)}/g, (_, min, max) => {
        const low = parseInt(min, 10);
        const high = parseInt(max, 10);
        return Math.floor(Math.random() * (high - low + 1)) + low;
    });

    // 3. Weather API Parser with Dynamic Phrasing
    if (text.includes('${weather')) {
        const weatherMatches = [...text.matchAll(/\${weather(?:\s+([^}]+))?}/g)];

        for (const match of weatherMatches) {
            const tagDefault = match[1]?.trim();
            const userArg = args.join(' ').trim();

            const location = userArg || tagDefault || 'Caldwell';
            const displayLabel = userArg ? userArg : channel;

            try {
                const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'CyberPupBot/1.0' }
                });

                if (res.ok) {
                    const data = await res.json();
                    const condition = data.current_condition[0];

                    const desc = condition.weatherDesc[0].value;
                    const tempF = condition.temp_F;
                    const tempC = condition.temp_C;
                    const feelsF = condition.FeelsLikeF;
                    const feelsC = condition.FeelsLikeC;
                    const windMph = condition.windspeedMiles;

                    const formatted = `Weather for ${displayLabel}: ${desc} ${tempF}°F (${tempC}°C) [Feels ${feelsF}°F / ${feelsC}°C] - Wind: ${windMph}mph`;
                    text = text.replace(match[0], formatted);
                } else {
                    text = text.replace(match[0], `[Location '${location}' not found]`);
                }
            } catch (e) {
                text = text.replace(match[0], '[Weather unavailable]');
            }
        }
    } // <--- End of weather if-block

    // 4. Custom API Parser
    if (text.includes('${customapi')) {
        const apiMatches = [...text.matchAll(/\${customapi\s+([^}]+)}/g)];
        for (const match of apiMatches) {
            const url = match[1].trim();
            try {
                const res = await fetch(url, { headers: { 'User-Agent': 'CyberPupBot/1.0' } });
                if (res.ok) {
                    const data = await res.text();
                    text = text.replace(match[0], data.trim());
                } else {
                    text = text.replace(match[0], '[API Error]');
                }
            } catch (e) {
                text = text.replace(match[0], '[API Fetch Failed]');
            }
        }
    } // <--- End of customapi if-block

    return text; // <--- MUST be inside parseVariables before closing brace below
} // <--- END OF parseVariables

async function main() {
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

    await authProvider.addUserForToken(tokenData, ['chat', 'moderator:manage:announcements']);

    const apiClient = new ApiClient({ authProvider });

    // Identify the bot account so we can ignore our own messages.
    // (Helix announcements echo back into chat as our own PRIVMSGs.)
    let botUserId = null;
    try {
        const me = await apiClient.users.getAuthenticatedUser();
        botUserId = me.id;
        console.log(`[Bot] Authenticated as ${me.displayName}`);
    } catch (e) {
        console.warn('[Bot] Could not resolve bot identity; self-message guard disabled.');
    }

    // Load channels
    const rows = db.prepare('SELECT name FROM channels').all();
    let channelsToJoin = rows.map(r => r.name);
    if (channelsToJoin.length === 0) {
        channelsToJoin = ['cyberpupbot'];
        db.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').run('cyberpupbot');
    }

    const chatClient = new ChatClient({ authProvider, channels: channelsToJoin });

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
                return chatClient.say(channel, `Joined #${target}!`);
            }
            if (action === 'leave' && target) {
                db.prepare('DELETE FROM channels WHERE name = ?').run(target);
                chatClient.part(target);
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
                await apiClient.chat.sendAnnouncement(broadcaster.id, {
                    message: message.slice(0, 500),
                    color
                });
                console.log(`[Announce] #${cleanChannel} (${color}): ${message}`);
            } catch (e) {
                console.warn('[Announce] failed:', e?.message || e);
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
                    return chatClient.say(channel, `Set userlevel for !${trigger} to ${value}`);
                }

                if (property === 'cooldown') {
                    const seconds = parseInt(value, 10);
                    if (isNaN(seconds)) return chatClient.say(channel, 'Cooldown must be a number in seconds.');
                    db.prepare('UPDATE commands SET cooldown = ? WHERE channel = ? AND trigger = ?')
                        .run(seconds, cleanChannel, trigger);
                    return chatClient.say(channel, `Set cooldown for !${trigger} to ${seconds}s`);
                }
            }
            return;
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

    await chatClient.connect();
    console.log('[Bot] CyberPupBot connected to Twitch Chat.');
}

main().catch(console.error);