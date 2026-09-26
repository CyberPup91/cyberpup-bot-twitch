// Helpers for the $announce command (Helix chat announcements).

export const ANNOUNCE_COLORS = ['blue', 'green', 'orange', 'purple', 'primary'];

/**
 * Parse "$announce [color] <message>" into { color, message }.
 * Color is optional and case-insensitive; defaults to 'primary'.
 * `message` is empty when there was nothing to announce.
 */
export function parseAnnounceArgs(text) {
    let rest = text.slice('$announce'.length).trim();
    let color = 'primary';
    const firstWord = rest.split(/\s+/)[0]?.toLowerCase();
    if (ANNOUNCE_COLORS.includes(firstWord)) {
        color = firstWord;
        rest = rest.slice(firstWord.length).trim();
    }
    return { color, message: rest };
}
