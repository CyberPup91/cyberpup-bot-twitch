// Trigger → Conditions → Actions engine.
//
// An automation is:
//   { id, name, enabled, channel ('*' or a channel name),
//     trigger_type: 'keyword' | 'regex' | 'command' | 'timer',
//     trigger_config: {...}, conditions: {...}, actions: [{type, ...}],
//     cooldown_sec, user_cooldown_sec, last_fired }
//
// Triggers:
//   keyword: { text, match: 'contains'|'equals'|'starts_with' } (case-insensitive)
//   regex:   { pattern, flags }            (flags: '' or 'i')
//   command: { name }                      (message is !name or $name)
//   timer:   { interval_sec (>=30), min_messages (>=0) }  (requires a specific channel)
//
// Conditions (message triggers only):
//   { min_level: 0-4, allow_users: [...], deny_users: [...] }
//
// Actions (run in order):
//   message:  { text }                     (variables supported)
//   announce: { text, color }              (bot must be mod; variables supported)
//   delay:    { ms }                       (pause between actions, max 60s)

export const TRIGGER_TYPES = [
    { id: 'keyword', name: 'Keyword in chat' },
    { id: 'regex', name: 'Regex match' },
    { id: 'command', name: 'Chat command' },
    { id: 'timer', name: 'Timer' },
];

export const ACTION_TYPES = [
    { id: 'message', name: 'Send chat message' },
    { id: 'announce', name: 'Send announcement' },
    { id: 'delay', name: 'Wait' },
];

export const ANNOUNCE_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];
const LEVELS = ['everyone', 'subscriber', 'moderator', 'broadcaster', 'superadmin'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJson(s, fallback) {
    try {
        const v = JSON.parse(s);
        return v ?? fallback;
    } catch {
        return fallback;
    }
}

export function rowToAutomation(row) {
    return {
        id: row.id,
        name: row.name,
        enabled: !!row.enabled,
        channel: (row.channel || '*').toLowerCase(),
        trigger_type: row.trigger_type,
        trigger_config: safeJson(row.trigger_config, {}),
        conditions: safeJson(row.conditions, {}),
        actions: safeJson(row.actions, []),
        cooldown_sec: row.cooldown_sec ?? 0,
        user_cooldown_sec: row.user_cooldown_sec ?? 0,
        last_fired: row.last_fired ?? 0,
        created_at: row.created_at ?? null,
    };
}

export function summarizeTrigger(auto) {
    const cfg = auto.trigger_config || {};
    switch (auto.trigger_type) {
        case 'keyword':
            return `keyword ${cfg.match || 'contains'} "${cfg.text || ''}"`;
        case 'regex':
            return `regex /${cfg.pattern || ''}/${cfg.flags || ''}`;
        case 'command':
            return `command !${cfg.name || ''}`;
        case 'timer': {
            const parts = [`every ${cfg.interval_sec || 0}s`];
            if (cfg.min_messages) parts.push(`≥${cfg.min_messages} msgs`);
            return parts.join(', ');
        }
        default:
            return auto.trigger_type;
    }
}

// ---------------------------------------------------------------------------
// Validation (used by the dashboard API; pure, no DB access)
// ---------------------------------------------------------------------------
function isInt(n) { return Number.isInteger(n); }

function cleanNameList(v) {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map((s) => String(s || '').toLowerCase().replace(/^@/, '').trim()).filter(Boolean))].slice(0, 100);
}

function validateTriggerConfig(type, cfg) {
    const errors = [];
    const c = { ...(cfg || {}) };

    if (type === 'keyword') {
        c.text = String(c.text || '').trim();
        if (!c.text) errors.push('keyword text is required');
        if (!['contains', 'equals', 'starts_with'].includes(c.match)) c.match = 'contains';
    } else if (type === 'regex') {
        c.pattern = String(c.pattern || '');
        if (!c.pattern) errors.push('regex pattern is required');
        else {
            try { new RegExp(c.pattern, c.flags === 'i' ? 'i' : ''); c.flags = c.flags === 'i' ? 'i' : ''; }
            catch { errors.push('regex pattern is invalid'); }
        }
    } else if (type === 'command') {
        c.name = String(c.name || '').toLowerCase().replace(/^[$!]/, '').trim();
        if (!c.name) errors.push('command name is required');
    } else if (type === 'timer') {
        c.interval_sec = parseInt(c.interval_sec, 10);
        if (!isInt(c.interval_sec) || c.interval_sec < 30) errors.push('timer interval must be at least 30 seconds');
        c.min_messages = parseInt(c.min_messages ?? 0, 10);
        if (!isInt(c.min_messages) || c.min_messages < 0) c.min_messages = 0;
    }
    return { errors, config: c };
}

function validateAction(a, i) {
    const errors = [];
    const type = a?.type;
    if (!ACTION_TYPES.some((t) => t.id === type)) {
        return { errors: [`action ${i + 1}: unknown type "${type}"`], action: null };
    }
    if (type === 'message') {
        const text = String(a.text || '');
        if (!text.trim()) errors.push(`action ${i + 1}: message text is required`);
        return { errors, action: { type, text } };
    }
    if (type === 'announce') {
        const text = String(a.text || '');
        if (!text.trim()) errors.push(`action ${i + 1}: announcement text is required`);
        const color = ANNOUNCE_COLORS.includes(a.color) ? a.color : 'primary';
        return { errors, action: { type, text, color } };
    }
    // delay
    let ms = parseInt(a.ms ?? 1000, 10);
    if (!isInt(ms) || ms < 0) ms = 0;
    if (ms > 60000) ms = 60000;
    return { errors, action: { type, ms } };
}

export function validateAutomation(input) {
    const errors = [];
    const name = String(input?.name || '').trim().slice(0, 80);
    if (!name) errors.push('name is required');

    const enabled = input?.enabled === false || input?.enabled === 0 ? 0 : 1;

    let channel = String(input?.channel || '*').toLowerCase().replace(/^#/, '').trim();
    if (!channel) channel = '*';

    const trigger_type = input?.trigger_type;
    if (!TRIGGER_TYPES.some((t) => t.id === trigger_type)) errors.push(`unknown trigger type "${trigger_type}"`);
    if (trigger_type === 'timer' && channel === '*') errors.push('timer triggers require a specific channel');

    const { errors: tErr, config: trigger_config } = validateTriggerConfig(trigger_type, input?.trigger_config);
    errors.push(...tErr);

    const cond = input?.conditions || {};
    let min_level = parseInt(cond.min_level ?? 0, 10);
    if (!isInt(min_level) || min_level < 0 || min_level > 4) min_level = 0;
    const conditions = {
        min_level,
        allow_users: cleanNameList(cond.allow_users),
        deny_users: cleanNameList(cond.deny_users),
    };

    const rawActions = Array.isArray(input?.actions) ? input.actions : [];
    if (rawActions.length === 0) errors.push('at least one action is required');
    if (rawActions.length > 20) errors.push('at most 20 actions per automation');
    const actions = [];
    for (let i = 0; i < rawActions.length; i++) {
        const { errors: aErr, action } = validateAction(rawActions[i], i);
        errors.push(...aErr);
        if (action) actions.push(action);
    }

    let cooldown_sec = parseInt(input?.cooldown_sec ?? 0, 10);
    if (!isInt(cooldown_sec) || cooldown_sec < 0) cooldown_sec = 0;
    let user_cooldown_sec = parseInt(input?.user_cooldown_sec ?? 0, 10);
    if (!isInt(user_cooldown_sec) || user_cooldown_sec < 0) user_cooldown_sec = 0;

    return {
        ok: errors.length === 0,
        errors,
        automation: { name, enabled, channel, trigger_type, trigger_config, conditions, actions, cooldown_sec, user_cooldown_sec },
    };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export function createAutomationEngine({ db, parseVariables, logEvent }) {
    const userCooldowns = new Map(); // `${automationId}:${cleanUser}` -> ms timestamp
    const channelMsgCounts = new Map(); // cleanChannel -> messages since timer fired

    function getEnabled() {
        return db.prepare('SELECT * FROM automations WHERE enabled = 1').all().map(rowToAutomation);
    }

    function markFired(auto) {
        const nowSec = Math.floor(Date.now() / 1000);
        db.prepare('UPDATE automations SET last_fired = ? WHERE id = ?').run(nowSec, auto.id);
        auto.last_fired = nowSec;
    }

    function matchTrigger(auto, ctx) {
        const cfg = auto.trigger_config || {};
        switch (auto.trigger_type) {
            case 'keyword': {
                const needle = String(cfg.text || '').toLowerCase();
                const hay = String(ctx.text || '').toLowerCase();
                if (!needle) return false;
                if (cfg.match === 'equals') return hay === needle;
                if (cfg.match === 'starts_with') return hay.startsWith(needle);
                return hay.includes(needle);
            }
            case 'regex': {
                try {
                    return new RegExp(cfg.pattern, cfg.flags || '').test(ctx.text || '');
                } catch {
                    return false;
                }
            }
            case 'command':
                return !!ctx.commandName && ctx.commandName === cfg.name;
            default:
                return false;
        }
    }

    function checkConditions(auto, ctx) {
        const c = auto.conditions || {};
        if ((c.min_level ?? 0) > (ctx.userLevel ?? 0)) return false;
        const allow = (c.allow_users || []).map((s) => s.toLowerCase());
        const deny = (c.deny_users || []).map((s) => s.toLowerCase());
        if (allow.length > 0 && !allow.includes(ctx.cleanUser)) return false;
        if (deny.includes(ctx.cleanUser)) return false;
        return true;
    }

    function checkCooldowns(auto, ctx) {
        const now = Date.now();
        if (auto.cooldown_sec > 0 && auto.last_fired > 0) {
            if (now - auto.last_fired * 1000 < auto.cooldown_sec * 1000) return false;
        }
        if (auto.user_cooldown_sec > 0 && ctx.cleanUser) {
            const last = userCooldowns.get(`${auto.id}:${ctx.cleanUser}`) || 0;
            if (now - last < auto.user_cooldown_sec * 1000) return false;
        }
        return true;
    }

    function noteUserCooldown(auto, ctx) {
        if (auto.user_cooldown_sec > 0 && ctx.cleanUser) {
            userCooldowns.set(`${auto.id}:${ctx.cleanUser}`, Date.now());
        }
    }

    async function runActions(auto, ctx, io) {
        const vctx = { user: ctx.user, channel: ctx.cleanChannel, args: ctx.args || [] };
        for (const action of auto.actions) {
            if (action.type === 'message') {
                const text = await parseVariables(action.text, vctx);
                if (text) await io.say(ctx.channel, text);
            } else if (action.type === 'announce') {
                const text = await parseVariables(action.text, vctx);
                if (text) await io.announce(ctx.cleanChannel, action.color || 'primary', text);
            } else if (action.type === 'delay') {
                if (action.ms > 0) await sleep(action.ms);
            }
        }
    }

    // Process one chat message against all message-triggered automations.
    // ctx: { channel ('#name'), cleanChannel, user, cleanUser, userLevel, text, args, commandName|null }
    async function processMessage(ctx, io) {
        channelMsgCounts.set(ctx.cleanChannel, (channelMsgCounts.get(ctx.cleanChannel) || 0) + 1);
        for (const auto of getEnabled()) {
            if (auto.trigger_type === 'timer') continue;
            if (auto.channel !== '*' && auto.channel !== ctx.cleanChannel) continue;
            if (!matchTrigger(auto, ctx)) continue;
            if (!checkConditions(auto, ctx)) continue;
            if (!checkCooldowns(auto, ctx)) continue;
            try {
                await runActions(auto, ctx, io);
                markFired(auto);
                noteUserCooldown(auto, ctx);
                logEvent('automation', `"${auto.name}" fired in #${ctx.cleanChannel} (triggered by ${ctx.user})`);
            } catch (e) {
                logEvent('error', `Automation "${auto.name}" failed: ${e?.message || e}`);
            }
        }
    }

    // Timer tick: fire due timer automations. Call every ~15s.
    async function processTimers(io) {
        const now = Date.now();
        for (const auto of getEnabled()) {
            if (auto.trigger_type !== 'timer') continue;
            const cfg = auto.trigger_config || {};
            const intervalMs = (cfg.interval_sec || 0) * 1000;
            if (intervalMs <= 0) continue;
            if (!io.isJoined(auto.channel)) continue;
            const lastFiredMs = (auto.last_fired || 0) * 1000;
            // Never-fired timers start their countdown at engine boot, not at t=0.
            if (lastFiredMs === 0) { markFired(auto); continue; }
            if (now - lastFiredMs < intervalMs) continue;
            const minMsgs = cfg.min_messages || 0;
            const msgCount = channelMsgCounts.get(auto.channel) || 0;
            if (msgCount < minMsgs) continue;

            const ctx = {
                channel: `#${auto.channel}`,
                cleanChannel: auto.channel,
                user: '', cleanUser: '', userLevel: 0,
                text: '', args: [], commandName: null,
            };
            try {
                await runActions(auto, ctx, io);
                markFired(auto);
                channelMsgCounts.set(auto.channel, 0);
                logEvent('automation', `"${auto.name}" timer fired in #${auto.channel}`);
            } catch (e) {
                logEvent('error', `Automation "${auto.name}" timer failed: ${e?.message || e}`);
            }
        }
    }

    return { processMessage, processTimers, getEnabled, matchTrigger, checkConditions, summarizeTrigger };
}
