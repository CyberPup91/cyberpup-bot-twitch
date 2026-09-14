import { RefreshingAuthProvider } from '@twurple/auth';
import { ChatClient } from '@twurple/chat';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import db from './db.js';

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

    await authProvider.addUserForToken(tokenData, ['chat']);

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
        // TIER 2: STREAMELEMENTS STYLE COMMAND MANAGEMENT ($cmd)
        // -------------------------------------------------------------
        if (text.startsWith('$cmd ') && isModOrBroadcaster) {
            const args = text.slice(5).trim().split(/\s+/);
            const subCommand = args.shift()?.toLowerCase();
            const trigger = args.shift()?.toLowerCase().replace('!', '');

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
        if (!text.startsWith('!')) return;
        const cmdArgs = text.slice(1).trim().split(/\s+/);
        const trigger = cmdArgs.shift().toLowerCase();

        const cmd = db.prepare('SELECT * FROM commands WHERE channel = ? AND trigger = ?').get(cleanChannel, trigger);

        if (cmd) {
            // Permission Check
            if (userLevel < cmd.userlevel) return;

            // Cooldown Check
            const now = Math.floor(Date.now() / 1000);
            if (cmd.last_used && (now - cmd.last_used) < cmd.cooldown) return;

            // Update Last Used
            db.prepare('UPDATE commands SET last_used = ? WHERE id = ?').run(now, cmd.id);

            // Variable Replacement Engine
            let response = cmd.response
                .replace(/\${user}/g, user)
                .replace(/\${channel}/g, cleanChannel)
                .replace(/\${touser}/g, cmdArgs[0] ? cmdArgs[0].replace('@', '') : user)
                .replace(/\${random\.(\d+)-(\d+)}/g, (_, min, max) => {
                    return Math.floor(Math.random() * (parseInt(max) - parseInt(min) + 1)) + parseInt(min);
                });

            chatClient.say(channel, response);
        }
    });

    await chatClient.connect();
    console.log('[Bot] CyberPupBot connected to Twitch Chat.');
}

main().catch(console.error);