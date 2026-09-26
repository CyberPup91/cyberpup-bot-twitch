// Shared template variable engine, used by custom commands (!cmd) and by
// automations. Supports:
//   ${user} ${channel} ${touser} ${query} ${1}..${N}
//   ${random.1-100}
//   ${weather [location]}   (wttr.in)
//   ${customapi <url>}

export async function parseVariables(template, context) {
    const { user, channel, args, extra } = context;
    const touser = args[0] ? args[0].replace('@', '') : user;

    let text = template;

    // 1. Basic Identity & Argument Variables
    text = text.replace(/\${user}/g, user);
    text = text.replace(/\${channel}/g, channel);
    text = text.replace(/\${touser}/g, touser);
    text = text.replace(/\${query}/g, args.join(' ') || user);
    text = text.replace(/\${(\d+)}/g, (_, index) => args[parseInt(index, 10) - 1] || '');

    // 1b. Event variables (e.g. ${raider}, ${viewers}, ${raid_target}).
    // Runs after the built-ins so built-in names always win on collision.
    if (extra && typeof extra === 'object') {
        for (const [key, value] of Object.entries(extra)) {
            if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
            text = text.replace(new RegExp('\\${' + key + '}', 'g'), String(value ?? ''));
        }
    }

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
    }

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
    }

    return text;
}
