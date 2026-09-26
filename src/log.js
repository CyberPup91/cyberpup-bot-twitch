// Tiny in-process event bus for the dashboard's live log.
// Producers call logEvent(type, message); the dashboard streams entries
// to browsers over SSE and keeps a short history for new connections.

const listeners = new Set();
const buffer = [];
const MAX_BUFFER = 200;

export function logEvent(type, message) {
    const entry = { t: new Date().toISOString(), type, message };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    for (const fn of [...listeners]) {
        try { fn(entry); } catch { /* a dead SSE connection shouldn't kill the bot */ }
    }
    return entry;
}

export function getRecentEvents(n = 50) {
    return buffer.slice(-n);
}

/** Subscribe to new events. Returns an unsubscribe function. */
export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
