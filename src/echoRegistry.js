// Own-output echo registry.
//
// The bot runs on Ronson's main account, so incoming messages from the
// bot's own user ID are usually Ronson typing himself — those MUST be
// processed (that's how his $ commands reach the bot). The exception is
// echoes of the bot's own output (say/action/announcement), which Twitch
// sends back to chat; reprocessing those would cause automation/command
// loops.
//
// Every outgoing message is registered via noteOwnMessage() before it is
// sent. An incoming self-message that matches a recent registration is
// dropped as an echo by isOwnEcho(); anything else from this account is
// treated as Ronson typing and processed normally.

const ownEchoes = new Map(); // normalized text -> expiry timestamp
const OWN_ECHO_TTL_MS = 20000;

export function noteOwnMessage(text) {
    if (!text) return;
    ownEchoes.set(String(text).trim().toLowerCase(), Date.now() + OWN_ECHO_TTL_MS);
}

export function isOwnEcho(text) {
    const key = String(text || '').trim().toLowerCase();
    const exp = ownEchoes.get(key);
    if (exp !== undefined) {
        if (exp > Date.now()) return true;
        ownEchoes.delete(key);
    }
    if (ownEchoes.size > 1000) { // opportunistic prune of expired entries
        const now = Date.now();
        for (const [k, e] of ownEchoes) if (e <= now) ownEchoes.delete(k);
    }
    return false;
}

// For tests: clear the registry.
export function _clearEchoes() {
    ownEchoes.clear();
}
