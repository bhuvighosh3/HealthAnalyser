/**
 * Auth Controller
 *
 * Three login modes:
 *  1. "own credentials"  — user provides their Strava tokens
 *  2. "sample: bhuvi"    — Bhuvi's account (original .env tokens)
 *  3. "sample: rishit"   — Rishit's account (RISHIT_* env vars)
 */

const { tokens, updateEnv } = require('../services/stravaService');
const { initDatabase }       = require('../db/database');

// Freeze both sample token sets at startup
const SAMPLE_PROFILES = {
    bhuvi: {
        name:   'Bhuvi',
        ACCESS_TOKEN:  process.env.STRAVA_ACCESS_TOKEN,
        REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
        EXPIRES_AT:    process.env.STRAVA_EXPIRES_AT,
        CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
        CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
    },
    rishit: {
        name:   'Rishit',
        ACCESS_TOKEN:  process.env.RISHIT_ACCESS_TOKEN,
        REFRESH_TOKEN: process.env.RISHIT_REFRESH_TOKEN,
        EXPIRES_AT:    process.env.RISHIT_EXPIRES_AT,
        CLIENT_ID:     process.env.RISHIT_CLIENT_ID,
        CLIENT_SECRET: process.env.RISHIT_CLIENT_SECRET,
    },
    ritwik: {
        name:   'Ritwik',
        ACCESS_TOKEN:  process.env.RITWIK_ACCESS_TOKEN,
        REFRESH_TOKEN: process.env.RITWIK_REFRESH_TOKEN,
        EXPIRES_AT:    process.env.RITWIK_EXPIRES_AT,
        CLIENT_ID:     process.env.RITWIK_CLIENT_ID,
        CLIENT_SECRET: process.env.RITWIK_CLIENT_SECRET,
    },
};

// ── GET /api/auth/profiles ────────────────────────────────────────────────────
// Returns basic info (name, avatar, location) for each sample profile.
// Fetches live from Strava so avatars are always fresh.
exports.getProfiles = async (req, res) => {
    const { fetchFromStrava, updateEnv: swapTokens } = require('../services/stravaService');
    const results = {};

    for (const [key, p] of Object.entries(SAMPLE_PROFILES)) {
        if (!p.ACCESS_TOKEN) { results[key] = { name: p.name }; continue; }
        try {
            // Temporarily swap tokens to fetch this profile's athlete data
            swapTokens({
                STRAVA_ACCESS_TOKEN:  p.ACCESS_TOKEN,
                STRAVA_REFRESH_TOKEN: p.REFRESH_TOKEN  || '',
                STRAVA_EXPIRES_AT:    p.EXPIRES_AT     || '',
                STRAVA_CLIENT_ID:     p.CLIENT_ID      || '',
                STRAVA_CLIENT_SECRET: p.CLIENT_SECRET  || '',
            });
            const athlete = await fetchFromStrava('/athlete');
            results[key] = {
                name:     `${athlete.firstname} ${athlete.lastname}`,
                username: athlete.username,
                avatar:   athlete.profile_medium || athlete.profile || '',
                location: [athlete.city, athlete.country].filter(Boolean).join(', '),
                sex:      athlete.sex,
            };
        } catch (e) {
            console.warn(`[Auth/profiles] Could not fetch ${key}:`, e.message.slice(0, 60));
            results[key] = { name: p.name };
        }
    }

    // Restore whichever token was active before (last entry wins — restore bhuvi as default)
    const b = SAMPLE_PROFILES.bhuvi;
    swapTokens({
        STRAVA_ACCESS_TOKEN:  tokens.ACCESS_TOKEN  || b.ACCESS_TOKEN  || '',
        STRAVA_REFRESH_TOKEN: tokens.REFRESH_TOKEN || b.REFRESH_TOKEN || '',
        STRAVA_EXPIRES_AT:    tokens.EXPIRES_AT    || b.EXPIRES_AT    || '',
        STRAVA_CLIENT_ID:     tokens.CLIENT_ID     || b.CLIENT_ID     || '',
        STRAVA_CLIENT_SECRET: tokens.CLIENT_SECRET || b.CLIENT_SECRET || '',
    });

    res.json(results);
};

// ── POST /api/auth/sample ─────────────────────────────────────────────────────
// Body: { profile: 'bhuvi' | 'rishit' }
exports.useSample = async (req, res) => {
    const key = (req.body?.profile || 'bhuvi').toLowerCase();
    const p   = SAMPLE_PROFILES[key];

    if (!p) return res.status(400).json({ error: `Unknown profile "${key}". Use "bhuvi", "rishit", or "ritwik".` });
    if (!p.ACCESS_TOKEN) return res.status(500).json({ error: `No credentials configured for "${key}".` });

    try {
        updateEnv({
            STRAVA_ACCESS_TOKEN:  p.ACCESS_TOKEN,
            STRAVA_REFRESH_TOKEN: p.REFRESH_TOKEN  || '',
            STRAVA_EXPIRES_AT:    p.EXPIRES_AT     || '',
            STRAVA_CLIENT_ID:     p.CLIENT_ID      || '',
            STRAVA_CLIENT_SECRET: p.CLIENT_SECRET  || '',
        });

        await initDatabase();
        res.json({ ok: true, message: `Switched to ${p.name}'s account.` });
    } catch (err) {
        console.error('[Auth/sample]', err.message);
        res.status(500).json({ error: 'Failed to switch profile: ' + err.message });
    }
};

// ── POST /api/auth/configure ──────────────────────────────────────────────────
// User's own Strava credentials
exports.configure = async (req, res) => {
    const { clientId, clientSecret, accessToken, refreshToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });

    try {
        updateEnv({
            STRAVA_ACCESS_TOKEN:  accessToken,
            STRAVA_REFRESH_TOKEN: refreshToken || '',
            STRAVA_EXPIRES_AT:    String(Math.floor(Date.now() / 1000) + 21600),
            ...(clientId     && { STRAVA_CLIENT_ID:     clientId }),
            ...(clientSecret && { STRAVA_CLIENT_SECRET: clientSecret }),
        });
        await initDatabase();
        res.json({ ok: true, message: 'Credentials configured — using your Strava account.' });
    } catch (err) {
        console.error('[Auth/configure]', err.message);
        res.status(500).json({ error: 'Failed to configure credentials: ' + err.message });
    }
};
