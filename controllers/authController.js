/**
 * Auth Controller
 *
 * Handles two login modes:
 *  1. "own credentials" — user provides their Strava tokens, server switches to them
 *  2. "sample account"  — server resets to the original .env tokens (Bhuvi's account)
 */

const { tokens, updateEnv } = require('../services/stravaService');
const { initDatabase }       = require('../db/database');

// Keep a frozen copy of the original .env tokens so "sample" can always be restored
const _sampleTokens = {
    ACCESS_TOKEN:  process.env.STRAVA_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
    EXPIRES_AT:    process.env.STRAVA_EXPIRES_AT,
    CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
    CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
};

/**
 * POST /api/auth/configure
 * Body: { clientId, clientSecret, accessToken, refreshToken }
 *
 * Swaps the server's live Strava tokens for the user's own credentials.
 */
exports.configure = async (req, res) => {
    const { clientId, clientSecret, accessToken, refreshToken } = req.body;

    if (!accessToken) {
        return res.status(400).json({ error: 'accessToken is required' });
    }

    try {
        updateEnv({
            STRAVA_ACCESS_TOKEN:  accessToken,
            STRAVA_REFRESH_TOKEN: refreshToken || '',
            STRAVA_EXPIRES_AT:    String(Math.floor(Date.now() / 1000) + 21600), // assume 6h TTL
            ...(clientId     && { STRAVA_CLIENT_ID:     clientId }),
            ...(clientSecret && { STRAVA_CLIENT_SECRET: clientSecret }),
        });

        // Re-populate DB with the new account's data
        await initDatabase();

        res.json({ ok: true, message: 'Credentials configured — using your Strava account.' });
    } catch (err) {
        console.error('[Auth/configure]', err.message);
        res.status(500).json({ error: 'Failed to configure credentials: ' + err.message });
    }
};

/**
 * POST /api/auth/sample
 *
 * Resets the server back to the original sample account (Bhuvi's tokens from .env).
 */
exports.useSample = async (req, res) => {
    try {
        updateEnv({
            STRAVA_ACCESS_TOKEN:  _sampleTokens.ACCESS_TOKEN  || '',
            STRAVA_REFRESH_TOKEN: _sampleTokens.REFRESH_TOKEN || '',
            STRAVA_EXPIRES_AT:    _sampleTokens.EXPIRES_AT    || '',
            STRAVA_CLIENT_ID:     _sampleTokens.CLIENT_ID     || '',
            STRAVA_CLIENT_SECRET: _sampleTokens.CLIENT_SECRET || '',
        });

        await initDatabase();

        res.json({ ok: true, message: 'Switched to sample account (Bhuvi).' });
    } catch (err) {
        console.error('[Auth/sample]', err.message);
        res.status(500).json({ error: 'Failed to switch to sample account: ' + err.message });
    }
};
