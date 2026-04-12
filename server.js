require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Global tokens
let STRAVA_ACCESS_TOKEN = process.env.STRAVA_ACCESS_TOKEN;
let STRAVA_REFRESH_TOKEN = process.env.STRAVA_REFRESH_TOKEN;
let STRAVA_EXPIRES_AT = process.env.STRAVA_EXPIRES_AT;

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || "missing_key",
});

// Helper to update .env file
function updateEnv(newTokens) {
    let envContent = fs.readFileSync('.env', 'utf8');
    for (const [key, value] of Object.entries(newTokens)) {
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }
    }
    fs.writeFileSync('.env', envContent);
}

// Ensure token is valid before making API calls
async function ensureValidToken() {
    const now = Math.floor(Date.now() / 1000);
    // Refresh if expiring in less than 5 minutes or already expired
    if (STRAVA_EXPIRES_AT && now >= (parseInt(STRAVA_EXPIRES_AT) - 300) && STRAVA_REFRESH_TOKEN) {
        console.log("Token expiring soon, refreshing automatically...");
        try {
            const res = await fetch('https://www.strava.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_id: process.env.STRAVA_CLIENT_ID,
                    client_secret: process.env.STRAVA_CLIENT_SECRET,
                    grant_type: 'refresh_token',
                    refresh_token: STRAVA_REFRESH_TOKEN
                })
            });
            const data = await res.json();
            if (data.access_token) {
                STRAVA_ACCESS_TOKEN = data.access_token;
                STRAVA_REFRESH_TOKEN = data.refresh_token;
                STRAVA_EXPIRES_AT = data.expires_at;

                updateEnv({
                    STRAVA_ACCESS_TOKEN,
                    STRAVA_REFRESH_TOKEN,
                    STRAVA_EXPIRES_AT
                });
                console.log("✅ Token successfully refreshed!");
            }
        } catch (err) {
            console.error("Failed to refresh token:", err);
        }
    }
}

// --- OAuth Authorization Flow ---
app.get('/auth', (req, res) => {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const redirectUri = `http://localhost:${PORT}/exchange_token`;
    // We request 'activity:read_all' to get past activities and 'read' for profile details
    const authUrl = `http://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&approval_prompt=force&scope=activity:read_all,read`;
    res.redirect(authUrl);
});

app.get('/exchange_token', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Authorization failed!");

    try {
        const tokenRes = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code'
            })
        });
        const tokenData = await tokenRes.json();

        if (tokenData.access_token) {
            STRAVA_ACCESS_TOKEN = tokenData.access_token;
            STRAVA_REFRESH_TOKEN = tokenData.refresh_token;
            STRAVA_EXPIRES_AT = tokenData.expires_at;

            updateEnv({
                STRAVA_ACCESS_TOKEN,
                STRAVA_REFRESH_TOKEN,
                STRAVA_EXPIRES_AT
            });

            // Hydrate the SQL DB since we have a new fresh token
            await initDatabase();

            res.send(`
                <h2>✅ Authentication Successful!</h2>
                <p>We've securely saved your access and refresh tokens. The server will now auto-refresh them when they expire.</p>
                <a href="/">Go back to your Dashboard</a>
            `);
        } else {
            res.send("Failed to retrieve tokens. " + JSON.stringify(tokenData));
        }
    } catch (err) {
        res.status(500).send("Error authenticating: " + err.message);
    }
});


// --- Database Setup ---
const db = new sqlite3.Database(':memory:');
const runSQL = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
});
const allSQL = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

async function initDatabase() {
    await runSQL(`
        CREATE TABLE IF NOT EXISTS run_stats (
            period TEXT PRIMARY KEY,
            run_count INTEGER,
            distance_m REAL,
            moving_time_s INTEGER,
            elevation_gain_m REAL
        );
    `);

    try {
        await ensureValidToken();
        if (!STRAVA_ACCESS_TOKEN) return; // Silent skip if no token setup yet

        const athleteRes = await fetch('https://www.strava.com/api/v3/athlete', {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        const athlete = await athleteRes.json();

        const statsRes = await fetch(`https://www.strava.com/api/v3/athletes/${athlete.id}/stats`, {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        if (!statsRes.ok) return; // token invalid/expired, skip
        const stats = await statsRes.json();

        const r = stats.recent_run_totals || { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 };
        const y = stats.ytd_run_totals || { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 };
        const a = stats.all_run_totals || { count: 0, distance: 0, moving_time: 0, elevation_gain: 0 };

        const stmt = db.prepare('INSERT OR REPLACE INTO run_stats VALUES (?, ?, ?, ?, ?)');
        stmt.run('recent', r.count, r.distance, r.moving_time, r.elevation_gain || 0);
        stmt.run('ytd', y.count, y.distance, y.moving_time, y.elevation_gain || 0);
        stmt.run('all_time', a.count, a.distance, a.moving_time, a.elevation_gain || 0);
        stmt.finalize();

        console.log('✅ In-memory SQLite DB populated successfully');
    } catch (err) {
        console.error('Failed to populate DB', err);
    }
}
// Try to hydrate if token exists at boot
initDatabase();


// --- HTTP Routes ---
app.get('/api/athlete', async (req, res) => {
    try {
        await ensureValidToken();
        const response = await fetch('https://www.strava.com/api/v3/athlete', {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: 'Failed to fetch athlete data' }); }
});

app.get('/api/athlete/stats/:id', async (req, res) => {
    try {
        await ensureValidToken();
        const response = await fetch(`https://www.strava.com/api/v3/athletes/${req.params.id}/stats`, {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        res.json(await response.json());
    } catch (error) { res.status(500).json({ error: 'Failed to fetch athlete stats' }); }
});

// --- Fetch Activities ---
app.get('/api/activities', async (req, res) => {
    try {
        await ensureValidToken();
        const page = req.query.page || 1;
        const perPage = req.query.per_page || 30;
        const response = await fetch(
            `https://www.strava.com/api/v3/athlete/activities?page=${page}&per_page=${perPage}`,
            { headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` } }
        );
        if (!response.ok) {
            return res.status(response.status).json({ error: 'Failed to fetch activities' });
        }
        res.json(await response.json());
    } catch (error) {
        console.error('Activities error:', error);
        res.status(500).json({ error: 'Failed to fetch activities' });
    }
});

// --- AI Performance Analysis ---
app.post('/api/analyse', async (req, res) => {
    if (anthropic.apiKey === "missing_key") {
        return res.json({ error: "Missing ANTHROPIC_API_KEY in .env" });
    }

    try {
        await ensureValidToken();

        // Fetch activities
        const activitiesRes = await fetch(
            'https://www.strava.com/api/v3/athlete/activities?per_page=30',
            { headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` } }
        );
        const activities = await activitiesRes.json();

        if (!activities.length) {
            return res.json({ error: 'No activities found to analyse.' });
        }

        // Fetch athlete stats
        const athleteRes = await fetch('https://www.strava.com/api/v3/athlete', {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        const athlete = await athleteRes.json();
        const statsRes = await fetch(`https://www.strava.com/api/v3/athletes/${athlete.id}/stats`, {
            headers: { 'Authorization': `Bearer ${STRAVA_ACCESS_TOKEN}` }
        });
        const stats = await statsRes.json();

        const activitySummary = activities.map(a => ({
            name: a.name,
            type: a.type,
            date: a.start_date_local,
            distance_km: (a.distance / 1000).toFixed(2),
            moving_time_min: (a.moving_time / 60).toFixed(1),
            elapsed_time_min: (a.elapsed_time / 60).toFixed(1),
            elevation_gain_m: a.total_elevation_gain,
            average_speed_kmh: ((a.average_speed || 0) * 3.6).toFixed(2),
            max_speed_kmh: ((a.max_speed || 0) * 3.6).toFixed(2),
            average_heartrate: a.average_heartrate || null,
            max_heartrate: a.max_heartrate || null,
            suffer_score: a.suffer_score || null,
            kudos: a.kudos_count
        }));

        const prompt = `You are an expert running coach and data analyst. Analyse the following Strava data and return a JSON response.

ATHLETE STATS:
${JSON.stringify(stats, null, 2)}

RECENT ACTIVITIES (up to 30):
${JSON.stringify(activitySummary, null, 2)}

Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "charts": {
    "distanceTrend": {
      "labels": ["date1", "date2", ...],
      "data": [distance_in_km, ...]
    },
    "paceTrend": {
      "labels": ["date1", "date2", ...],
      "data": [pace_in_min_per_km, ...]
    },
    "weeklyVolume": {
      "labels": ["Week 1", "Week 2", ...],
      "data": [total_km_per_week, ...]
    },
    "activityTypes": {
      "labels": ["Run", "Ride", ...],
      "data": [count, ...]
    }
  },
  "insights": [
    {
      "title": "Distance Trends",
      "icon": "trending-up",
      "text": "2-3 sentence insight about distance patterns"
    },
    {
      "title": "Pace Analysis",
      "icon": "gauge",
      "text": "2-3 sentence insight about pace"
    },
    {
      "title": "Training Load",
      "icon": "flame",
      "text": "2-3 sentence insight about effort and consistency"
    },
    {
      "title": "Recommendations",
      "icon": "lightbulb",
      "text": "2-3 personalized actionable recommendations"
    }
  ]
}

Use the actual data from the activities. For pace, calculate min/km from speed. For weekly volume, group by calendar week. Sort chart data chronologically (oldest first). Be specific and reference actual numbers.`;

        const response = await anthropic.messages.create({
            model: "claude-3-haiku-20240307",
            max_tokens: 2000,
            messages: [{ role: "user", content: prompt }],
        });

        let text = response.content[0].text.trim();
        // Strip any markdown code fences
        text = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

        const analysis = JSON.parse(text);
        res.json(analysis);
    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'Failed to generate analysis' });
    }
});

app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage) return res.status(400).json({ error: "Missing message" });
    if (anthropic.apiKey === "missing_key") return res.json({ reply: "Missing ANTHROPIC_API_KEY in .env" });

    // Text-to-SQL Architecture
    const dbSchema = `CREATE TABLE run_stats (period TEXT PRIMARY KEY, run_count INTEGER, distance_m REAL, moving_time_s INTEGER, elevation_gain_m REAL);
    Note: period can be 'recent', 'ytd', or 'all_time'.`;

    try {
        const sqlGenPrompt = `You are a strict SQL bot. The user wants to query their Strava runs database. 
Schema: ${dbSchema}
Respond ONLY with the precise raw SQL query to answer their question: "${userMessage}". Do not wrap it in markdown.`;

        const sqlGenResponse = await anthropic.messages.create({
            model: "claude-3-haiku-20240307", max_tokens: 100,
            messages: [{ role: "user", content: sqlGenPrompt }],
        });

        let sqlQuery = sqlGenResponse.content[0].text.trim();
        sqlQuery = sqlQuery.replace(/^```sql/i, '').replace(/```$/i, '').trim();
        console.log("[AI] Generated SQL:", sqlQuery);

        let queryResults = [];
        try {
            queryResults = await allSQL(sqlQuery);
        } catch (sqlErr) {
            console.error("[SQL] Error:", sqlErr);
            return res.json({ reply: `I failed to execute the SQL generated: ${sqlQuery}. Error: ${sqlErr}` });
        }

        const answerPrompt = `You are an AI Strava assistant integrated in a sleek dashboard. 
The user asked: "${userMessage}".
I ran this SQL query: "${sqlQuery}" against their schema and got these results: ${JSON.stringify(queryResults)}.
Provide a conversational, engaging, and directly helpful answer to the user based on these results. Keep it concise.`;

        const finalResponse = await anthropic.messages.create({
            model: "claude-3-haiku-20240307", max_tokens: 400,
            messages: [{ role: "user", content: answerPrompt }],
        });

        res.json({ reply: finalResponse.content[0].text });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ error: 'Failed to communicate with Assistant' });
    }
});

app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));
