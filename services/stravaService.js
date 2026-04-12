const fs = require('fs');
const { resetMcpClient } = require('./mcpService');

const tokens = {
    ACCESS_TOKEN: process.env.STRAVA_ACCESS_TOKEN,
    REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
    EXPIRES_AT: process.env.STRAVA_EXPIRES_AT,
    CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET
};

function updateEnv(newTokens) {
    let envContent = fs.readFileSync('.env', 'utf8');
    for (const [key, value] of Object.entries(newTokens)) {
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
        if (key === 'STRAVA_ACCESS_TOKEN') tokens.ACCESS_TOKEN = value;
        if (key === 'STRAVA_REFRESH_TOKEN') tokens.REFRESH_TOKEN = value;
        if (key === 'STRAVA_EXPIRES_AT') tokens.EXPIRES_AT = value;
    }
    fs.writeFileSync('.env', envContent);
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

async function fetchFromStrava(endpoint) {
    await ensureValidToken();
    if (!tokens.ACCESS_TOKEN) throw new Error("No Access Token Available");
    const res = await fetch(`https://www.strava.com/api/v3${endpoint}`, {
        headers: { 'Authorization': `Bearer ${tokens.ACCESS_TOKEN}` }
    });
    if (!res.ok) throw new Error(`Strava API Error: ${res.status}`);
    return res.json();
}

async function exchangeToken(code) {
    const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: tokens.CLIENT_ID,
            client_secret: tokens.CLIENT_SECRET,
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
    exchangeToken
};
