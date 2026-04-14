const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { resetMcpClient } = require('./mcpService');

// ── Global token store (mutated on profile switch / token refresh) ─────────────
const tokens = {
    ACCESS_TOKEN: process.env.STRAVA_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
    EXPIRES_AT: process.env.STRAVA_EXPIRES_AT,
    CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET
};

// ── Per-request token context (avoids multi-instance / race-condition issues) ──
// Middleware populates this store from the X-Profile header so every request
// gets the right tokens regardless of which Cloud Run instance handles it.
const requestTokenStore = new AsyncLocalStorage();

// Frozen at startup — safe to read on any instance without shared mutable state
const PROFILE_TOKENS = {
    bhuvi: {
        ACCESS_TOKEN:  process.env.STRAVA_ACCESS_TOKEN,
        REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
        EXPIRES_AT:    process.env.STRAVA_EXPIRES_AT,
        CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
        CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
    },
    rishit: {
        ACCESS_TOKEN:  process.env.RISHIT_ACCESS_TOKEN,
        REFRESH_TOKEN: process.env.RISHIT_REFRESH_TOKEN,
        EXPIRES_AT:    process.env.RISHIT_EXPIRES_AT,
        CLIENT_ID:     process.env.RISHIT_CLIENT_ID,
        CLIENT_SECRET: process.env.RISHIT_CLIENT_SECRET,
    },
};

function updateEnv(newTokens) {
    // Always update in-memory tokens first (works in all environments)
    for (const [key, value] of Object.entries(newTokens)) {
        if (key === 'STRAVA_ACCESS_TOKEN')  tokens.ACCESS_TOKEN  = value;
        if (key === 'STRAVA_REFRESH_TOKEN') tokens.REFRESH_TOKEN = value;
        if (key === 'STRAVA_EXPIRES_AT')    tokens.EXPIRES_AT    = value;
    }
    // Persist to .env when running locally — silently skip in cloud environments
    try {
        let envContent = fs.readFileSync('.env', 'utf8');
        for (const [key, value] of Object.entries(newTokens)) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            envContent = regex.test(envContent)
                ? envContent.replace(regex, `${key}=${value}`)
                : envContent + `\n${key}=${value}`;
        }
        fs.writeFileSync('.env', envContent);
    } catch (_) {
        // Cloud Run / read-only FS — tokens already updated in memory above
    }
}

async function ensureValidToken() {
    if (!tokens.REFRESH_TOKEN) return;

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = parseInt(tokens.EXPIRES_AT) || 0;
    const needsRefresh = !tokens.ACCESS_TOKEN || (expiresAt - now) <= 3600;

    if (!needsRefresh) return;

    console.log("Token expiring within 1 hour — refreshing...");
    try {
        const res = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id:     tokens.CLIENT_ID,
                client_secret: tokens.CLIENT_SECRET,
                grant_type:    'refresh_token',
                refresh_token: tokens.REFRESH_TOKEN   // always use latest stored token
            })
        });
        const data = await res.json();
        if (data.access_token) {
            // Always overwrite with newest tokens (refresh_token rotates on each refresh)
            updateEnv({
                STRAVA_ACCESS_TOKEN:  data.access_token,
                STRAVA_REFRESH_TOKEN: data.refresh_token,
                STRAVA_EXPIRES_AT:    data.expires_at
            });
            resetMcpClient();
            console.log(`✅ Token refreshed — expires in ${data.expires_in}s`);
        } else {
            console.error("Token refresh failed:", data);
        }
    } catch (err) {
        console.error("Failed to refresh token:", err);
    }
}

async function ensureValidProfileToken(profileTokens) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = parseInt(profileTokens.EXPIRES_AT) || 0;
    const needsRefresh = !profileTokens.ACCESS_TOKEN || (expiresAt - now) <= 3600;

    if (!needsRefresh) return;

    if (!profileTokens.REFRESH_TOKEN) return;

    console.log(`Profile token expiring within 1 hour — refreshing...`);
    try {
        const res = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id:     profileTokens.CLIENT_ID,
                client_secret: profileTokens.CLIENT_SECRET,
                grant_type:    'refresh_token',
                refresh_token: profileTokens.REFRESH_TOKEN,
            })
        });
        const data = await res.json();
        if (data.access_token) {
            profileTokens.ACCESS_TOKEN  = data.access_token;
            profileTokens.REFRESH_TOKEN = data.refresh_token;
            profileTokens.EXPIRES_AT    = String(data.expires_at);
            console.log(`✅ Profile token refreshed — expires in ${data.expires_in}s`);
        } else {
            console.error('Profile token refresh failed:', data);
        }
    } catch (err) {
        console.error('Failed to refresh profile token:', err);
    }
}

async function fetchFromStrava(endpoint) {
    // Use request-scoped tokens if set (from X-Profile header), else fall back to global
    const requestTokens = requestTokenStore.getStore();
    const t = requestTokens || tokens;

    if (requestTokens) {
        await ensureValidProfileToken(requestTokens);
    } else {
        await ensureValidToken();
    }

    if (!t.ACCESS_TOKEN) throw new Error("No Access Token Available");
    const res = await fetch(`https://www.strava.com/api/v3${endpoint}`, {
        headers: { 'Authorization': `Bearer ${t.ACCESS_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Strava API Error: ${res.status}`);
    return res.json();
}

async function exchangeToken(code, profile) {
    const creds = profile === 'rishit' ? PROFILE_TOKENS.rishit : tokens;
    const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: creds.CLIENT_ID,
            client_secret: creds.CLIENT_SECRET,
            code: code,
            grant_type: 'authorization_code'
        })
    });
    return res.json();
}

module.exports = {
    tokens,
    updateEnv,
    ensureValidToken,
    fetchFromStrava,
    exchangeToken,
    requestTokenStore,
    PROFILE_TOKENS,
};
