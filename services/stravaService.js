const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { resetMcpClient } = require('./mcpService');
const { Firestore } = require('@google-cloud/firestore');

// ── Firestore token persistence ───────────────────────────────────────────────
// Persists profile tokens so Cloud Run instances always get the latest tokens
// even after rotation or re-auth (mirrors how Google Calendar tokens work).
const _firestoreDb = new Firestore({ projectId: process.env.GCP_PROJECT_ID || 'healthmonitor-493021' });
const STRAVA_TOKEN_COLLECTION = 'strava_profile_tokens';

async function saveProfileTokensToFirestore(profileKey, tokenData) {
    try {
        await _firestoreDb.collection(STRAVA_TOKEN_COLLECTION).doc(profileKey).set({
            ACCESS_TOKEN:  tokenData.ACCESS_TOKEN,
            REFRESH_TOKEN: tokenData.REFRESH_TOKEN,
            EXPIRES_AT:    tokenData.EXPIRES_AT,
            updatedAt:     new Date(),
        });
    } catch (e) {
        console.warn(`[Strava/Firestore] Failed to save tokens for ${profileKey}:`, e.message);
    }
}

async function loadProfileTokensFromFirestore(profileKey) {
    try {
        const doc = await _firestoreDb.collection(STRAVA_TOKEN_COLLECTION).doc(profileKey).get();
        return doc.exists ? doc.data() : null;
    } catch (e) {
        console.warn(`[Strava/Firestore] Failed to load tokens for ${profileKey}:`, e.message);
        return null;
    }
}

// ── Global token store (mutated on profile switch / token refresh) ─────────────
const tokens = {
    ACCESS_TOKEN: process.env.BHUVI_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.BHUVI_REFRESH_TOKEN,
    EXPIRES_AT: process.env.BHUVI_EXPIRES_AT,
    CLIENT_ID: process.env.BHUVI_CLIENT_ID,
    CLIENT_SECRET: process.env.BHUVI_CLIENT_SECRET
};

// ── Per-request token context (avoids multi-instance / race-condition issues) ──
// Middleware populates this store from the X-Profile header so every request
// gets the right tokens regardless of which Cloud Run instance handles it.
const requestTokenStore = new AsyncLocalStorage();

// Per-profile token objects. If two profiles share the same ACCESS_TOKEN
// (i.e. the same underlying Strava account) they point to the SAME object
// so a rotating refresh on either profile keeps both in sync and neither
// ends up holding a stale, invalidated refresh token.
const _builtinBhuvi = {
    ACCESS_TOKEN:  process.env.BHUVI_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.BHUVI_REFRESH_TOKEN,
    EXPIRES_AT:    process.env.BHUVI_EXPIRES_AT,
    CLIENT_ID:     process.env.BHUVI_CLIENT_ID,
    CLIENT_SECRET: process.env.BHUVI_CLIENT_SECRET,
};

const _builtinRishit = {
    ACCESS_TOKEN:  process.env.RISHIT_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.RISHIT_REFRESH_TOKEN,
    EXPIRES_AT:    process.env.RISHIT_EXPIRES_AT,
    CLIENT_ID:     process.env.RISHIT_CLIENT_ID,
    CLIENT_SECRET: process.env.RISHIT_CLIENT_SECRET,
};

const _builtinRitwik = {
    ACCESS_TOKEN:  process.env.RITWIK_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.RITWIK_REFRESH_TOKEN,
    EXPIRES_AT:    process.env.RITWIK_EXPIRES_AT,
    CLIENT_ID:     process.env.RITWIK_CLIENT_ID,
    CLIENT_SECRET: process.env.RITWIK_CLIENT_SECRET,
};

// Each profile is a fully independent object with its own tokens.
// ensureValidProfileToken mutates these in-place on refresh and writes
// back to the matching BHUVI_* / RISHIT_* / RITWIK_* env vars.
const PROFILE_TOKENS = {
    bhuvi:  _builtinBhuvi,
    rishit: _builtinRishit,
    ritwik: _builtinRitwik,
};

function updateEnv(newTokens) {
    // Always update in-memory tokens first (works in all environments)
    for (const [key, value] of Object.entries(newTokens)) {
        if (key === 'BHUVI_ACCESS_TOKEN')  tokens.ACCESS_TOKEN  = value;
        if (key === 'BHUVI_REFRESH_TOKEN') tokens.REFRESH_TOKEN = value;
        if (key === 'BHUVI_EXPIRES_AT')    tokens.EXPIRES_AT    = value;
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
                BHUVI_ACCESS_TOKEN:  data.access_token,
                BHUVI_REFRESH_TOKEN: data.refresh_token,
                BHUVI_EXPIRES_AT:    data.expires_at
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
            // Determine prefix from CLIENT_ID so the right env var is written back
            const prefix = profileTokens.CLIENT_ID === process.env.RISHIT_CLIENT_ID
                ? 'RISHIT'
                : profileTokens.CLIENT_ID === process.env.RITWIK_CLIENT_ID
                    ? 'RITWIK' : 'BHUVI';
            updateEnv({
                [`${prefix}_ACCESS_TOKEN`]:  data.access_token,
                [`${prefix}_REFRESH_TOKEN`]: data.refresh_token,
                [`${prefix}_EXPIRES_AT`]:    data.expires_at,
            });
            // Persist to Firestore so new Cloud Run instances get the rotated token
            const profileKey = prefix.toLowerCase();
            saveProfileTokensToFirestore(profileKey, profileTokens);
            console.log(`✅ Profile token refreshed (${prefix}) — expires in ${data.expires_in}s`);
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
    const creds = PROFILE_TOKENS[profile] || tokens;
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

// Called once at startup: pull the latest tokens from Firestore into PROFILE_TOKENS
// so Cloud Run cold-starts always have the most recently rotated tokens.
async function warmProfileTokensFromFirestore() {
    for (const [key, profileTokens] of Object.entries(PROFILE_TOKENS)) {
        const stored = await loadProfileTokensFromFirestore(key);
        if (!stored) continue;
        // Only apply if Firestore has a newer or longer-lived token
        const storedExpiry  = parseInt(stored.EXPIRES_AT)  || 0;
        const currentExpiry = parseInt(profileTokens.EXPIRES_AT) || 0;
        if (storedExpiry > currentExpiry) {
            profileTokens.ACCESS_TOKEN  = stored.ACCESS_TOKEN;
            profileTokens.REFRESH_TOKEN = stored.REFRESH_TOKEN;
            profileTokens.EXPIRES_AT    = stored.EXPIRES_AT;
            console.log(`🔄 Loaded fresher ${key} token from Firestore (expires ${new Date(storedExpiry * 1000).toISOString()})`);
        }
    }
}

module.exports = {
    tokens,
    updateEnv,
    ensureValidToken,
    fetchFromStrava,
    exchangeToken,
    requestTokenStore,
    PROFILE_TOKENS,
    ensureValidProfileToken,
    warmProfileTokensFromFirestore,
    saveProfileTokensToFirestore,
};
