// Web dashboard for CyberPup Bot: Express app serving a static UI plus a
// small JSON API over the same SQLite database the bot uses.
//
// Mounted into the bot process via startDashboard(); the bot passes its live
// db handle and chatClient so dashboard actions (join/part) take effect
// immediately without a restart.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRecentEvents, subscribe, logEvent } from './log.js';
import {
    validateAutomation,
    rowToAutomation,
    summarizeTrigger,
    TRIGGER_TYPES,
    ACTION_TYPES,
    ANNOUNCE_COLORS,
} from './automations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEVEL_NAMES = ['everyone', 'subscriber', 'moderator', 'broadcaster', 'superadmin'];

function normalizeTrigger(t) {
    return (t || '').toLowerCase().replace(/^[$!]/, '').trim();
}

function parseLevel(v) {
    if (Number.isInteger(v) && v >= 0 && v <= 4) return v;
    const i = LEVEL_NAMES.indexOf(String(v ?? '').toLowerCase());
    return i >= 0 ? i : 0;
}

function parseCooldown(v) {
    const n = parseInt(v ?? 5, 10);
    return Number.isNaN(n) ? 5 : Math.max(0, n);
}

export function startDashboard({ db, chatClient, info = {}, port = 3000, host = '127.0.0.1' }) {
    const app = express();
    app.use(express.json());

    // ---- meta ----
    app.get('/api/meta', (req, res) => {
        res.json({ levels: LEVEL_NAMES.map((name, value) => ({ name, value })) });
    });

    // ---- status ----
    app.get('/api/status', (req, res) => {
        let channels = 0;
        let commands = 0;
        let automations = 0;
        try {
            channels = db.prepare('SELECT COUNT(*) AS n FROM channels').get().n;
            commands = db.prepare('SELECT COUNT(*) AS n FROM commands').get().n;
            automations = db.prepare('SELECT COUNT(*) AS n FROM automations').get().n;
        } catch { /* db not ready yet */ }
        res.json({
            botName: info.botName || 'unknown',
            uptimeSec: Math.floor((Date.now() - (info.startedAt || Date.now())) / 1000),
            channels,
            commands,
            automations
        });
    });

    // ---- channels ----
    app.get('/api/channels', (req, res) => {
        res.json(db.prepare('SELECT name FROM channels ORDER BY name').all());
    });

    app.post('/api/channels', async (req, res) => {
        const name = (req.body?.name || '').toLowerCase().replace(/^#/, '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        db.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').run(name);
        try {
            await chatClient.join(name);
        } catch (e) {
            // Not connected yet: the channel is in the DB and will be joined on next start.
        }
        logEvent('channel', `Joined #${name} (via dashboard)`);
        res.status(201).json({ name });
    });

    app.delete('/api/channels/:name', async (req, res) => {
        const name = req.params.name.toLowerCase();
        const r = db.prepare('DELETE FROM channels WHERE name = ?').run(name);
        if (r.changes === 0) return res.status(404).json({ error: 'channel not found' });
        try { chatClient.part(name); } catch { /* ignore */ }
        logEvent('channel', `Left #${name} (via dashboard)`);
        res.json({ ok: true });
    });

    // ---- commands ----
    app.get('/api/commands', (req, res) => {
        const channel = (req.query.channel || '').toLowerCase().trim();
        const rows = channel
            ? db.prepare('SELECT * FROM commands WHERE channel = ? ORDER BY trigger').all(channel)
            : db.prepare('SELECT * FROM commands ORDER BY channel, trigger').all();
        res.json(rows);
    });

    app.post('/api/commands', (req, res) => {
        const channel = (req.body?.channel || '').toLowerCase().trim();
        const trigger = normalizeTrigger(req.body?.trigger);
        const response = req.body?.response || '';
        if (!channel || !trigger || !response) {
            return res.status(400).json({ error: 'channel, trigger and response are required' });
        }
        try {
            const r = db.prepare(
                'INSERT INTO commands (channel, trigger, response, userlevel, cooldown) VALUES (?, ?, ?, ?, ?)'
            ).run(channel, trigger, response, parseLevel(req.body.userlevel), parseCooldown(req.body.cooldown));
            logEvent('command', `Added !${trigger} in #${channel} (via dashboard)`);
            res.status(201).json({ id: Number(r.lastInsertRowid) });
        } catch (e) {
            res.status(409).json({ error: `Command !${trigger} already exists in #${channel}` });
        }
    });

    app.put('/api/commands/:id', (req, res) => {
        const sets = [];
        const vals = [];
        if (req.body?.response !== undefined) { sets.push('response = ?'); vals.push(req.body.response); }
        if (req.body?.userlevel !== undefined) { sets.push('userlevel = ?'); vals.push(parseLevel(req.body.userlevel)); }
        if (req.body?.cooldown !== undefined) { sets.push('cooldown = ?'); vals.push(parseCooldown(req.body.cooldown)); }
        if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
        vals.push(req.params.id);
        const r = db.prepare(`UPDATE commands SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        if (r.changes === 0) return res.status(404).json({ error: 'command not found' });
        logEvent('command', `Updated command #${req.params.id} (via dashboard)`);
        res.json({ ok: true });
    });

    app.delete('/api/commands/:id', (req, res) => {
        const r = db.prepare('DELETE FROM commands WHERE id = ?').run(req.params.id);
        if (r.changes === 0) return res.status(404).json({ error: 'command not found' });
        logEvent('command', `Deleted command #${req.params.id} (via dashboard)`);
        res.json({ ok: true });
    });

    // ---- automations (trigger → conditions → actions) ----
    app.get('/api/automation-meta', (req, res) => {
        res.json({
            trigger_types: TRIGGER_TYPES,
            action_types: ACTION_TYPES,
            announce_colors: ANNOUNCE_COLORS,
            levels: LEVEL_NAMES.map((name, value) => ({ name, value }))
        });
    });

    app.get('/api/automations', (req, res) => {
        const rows = db.prepare('SELECT * FROM automations ORDER BY name').all().map(rowToAutomation);
        res.json(rows.map((a) => ({ ...a, trigger_summary: summarizeTrigger(a) })));
    });

    app.post('/api/automations', (req, res) => {
        const { ok, errors, automation } = validateAutomation(req.body);
        if (!ok) return res.status(400).json({ error: errors.join('; ') });
        const r = db.prepare(`
            INSERT INTO automations
                (name, enabled, channel, trigger_type, trigger_config, conditions, actions, cooldown_sec, user_cooldown_sec)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            automation.name, automation.enabled, automation.channel, automation.trigger_type,
            JSON.stringify(automation.trigger_config), JSON.stringify(automation.conditions),
            JSON.stringify(automation.actions), automation.cooldown_sec, automation.user_cooldown_sec
        );
        logEvent('automation', `Created automation "${automation.name}" (via dashboard)`);
        res.status(201).json({ id: Number(r.lastInsertRowid) });
    });

    app.put('/api/automations/:id', (req, res) => {
        const { ok, errors, automation } = validateAutomation(req.body);
        if (!ok) return res.status(400).json({ error: errors.join('; ') });
        const r = db.prepare(`
            UPDATE automations SET
                name = ?, enabled = ?, channel = ?, trigger_type = ?,
                trigger_config = ?, conditions = ?, actions = ?,
                cooldown_sec = ?, user_cooldown_sec = ?
            WHERE id = ?
        `).run(
            automation.name, automation.enabled, automation.channel, automation.trigger_type,
            JSON.stringify(automation.trigger_config), JSON.stringify(automation.conditions),
            JSON.stringify(automation.actions), automation.cooldown_sec, automation.user_cooldown_sec,
            req.params.id
        );
        if (r.changes === 0) return res.status(404).json({ error: 'automation not found' });
        logEvent('automation', `Updated automation "${automation.name}" (via dashboard)`);
        res.json({ ok: true });
    });

    app.delete('/api/automations/:id', (req, res) => {
        const r = db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);
        if (r.changes === 0) return res.status(404).json({ error: 'automation not found' });
        logEvent('automation', `Deleted automation #${req.params.id} (via dashboard)`);
        res.json({ ok: true });
    });

    // ---- live event log (Server-Sent Events) ----
    app.get('/api/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });
        res.write(`data: ${JSON.stringify({ t: new Date().toISOString(), type: '__hello', message: 'connected' })}\n\n`);
        for (const e of getRecentEvents()) {
            res.write(`data: ${JSON.stringify(e)}\n\n`);
        }
        const unsubscribe = subscribe((entry) => {
            res.write(`data: ${JSON.stringify(entry)}\n\n`);
        });
        req.on('close', unsubscribe);
    });

    // ---- static UI ----
    app.use(express.static(path.join(__dirname, 'public')));

    const server = app.listen(port, host, () => {
        console.log(`[Dashboard] Listening on http://${host}:${port}`);
    });
    server.on('error', (e) => {
        console.warn(`[Dashboard] Could not start on ${host}:${port}: ${e.message}`);
    });
    return server;
}
