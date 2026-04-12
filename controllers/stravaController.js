const { fetchFromStrava, exchangeToken } = require('../services/stravaService');
const { storeActivities, RUN_TYPES } = require('../db/database');

exports.authorize = (req, res) => {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const host = process.env.APP_URL || `http://${req.headers.host}`;
    const redirectUri = `${host}/exchange_token`;
    const authUrl = `http://www.strava.com/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=force&scope=activity:read_all,read`;
    res.redirect(authUrl);
};

exports.exchangeToken = async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Authorization failed!");

    try {
        const tokenData = await exchangeToken(code);
        if (tokenData.access_token) {
            // Re-init DB with new tokens
            const { initDatabase, updateEnv } = require('../db/database');
            const { updateEnv: updateTokens } = require('../services/stravaService');
            updateTokens({
                STRAVA_ACCESS_TOKEN: tokenData.access_token,
                STRAVA_REFRESH_TOKEN: tokenData.refresh_token,
                STRAVA_EXPIRES_AT: tokenData.expires_at
            });
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
};

exports.getAthlete = async (req, res) => {
    try {
        const athlete = await fetchFromStrava('/athlete');
        res.json(athlete);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch athlete data' }); }
};

exports.getAthleteStats = async (req, res) => {
    try {
        const stats = await fetchFromStrava(`/athletes/${req.params.id}/stats`);

        try {
            const fourWeeksAgo = Math.floor(Date.now() / 1000) - (28 * 24 * 60 * 60);
            const recentActs = await fetchFromStrava(`/athlete/activities?per_page=100&after=${fourWeeksAgo}`);
            await storeActivities(recentActs);
            const runs = recentActs.filter(a => RUN_TYPES.has(a.type));

            stats.recent_run_totals = {
                count: runs.length,
                distance: runs.reduce((s, a) => s + a.distance, 0),
                moving_time: runs.reduce((s, a) => s + a.moving_time, 0),
                elevation_gain: runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
            };

            // Consistency: % of the 4 weeks that had at least one run
            const runWeeks = new Set(runs.map(a => {
                const d = new Date(a.start_date);
                return `${d.getFullYear()}-${d.getMonth()}-W${Math.ceil(d.getDate() / 7)}`;
            }));
            const consistencyScore = Math.min(100, Math.round((runWeeks.size / 4) * 100));

            // Avg suffer score from runs that have one
            const sufferScores = runs.filter(r => r.suffer_score > 0).map(r => r.suffer_score);
            const avgSufferScore = sufferScores.length
                ? Math.round(sufferScores.reduce((s, v) => s + v, 0) / sufferScores.length)
                : null;

            stats.computed = { consistencyScore, avgSufferScore };
        } catch (e) {
            console.error('[Stats] Failed to recompute recent runs:', e.message);
        }

        res.json(stats);
    } catch (error) { res.status(500).json({ error: 'Failed to fetch athlete stats' }); }
};

exports.getActivities = async (req, res) => {
    try {
        const page = req.query.page || 1;
        const perPage = req.query.per_page || 30;
        const activities = await fetchFromStrava(`/athlete/activities?page=${page}&per_page=${perPage}`);
        await storeActivities(activities);
        res.json(activities);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch activities' });
    }
};

exports.getCharts = async (req, res) => {
    try {
        const activities = await fetchFromStrava('/athlete/activities?per_page=30');

        if (!activities || !activities.length) return res.json({ charts: {} });

        // Reverse for chronological order
        const recent = [...activities].reverse();
        
        const distanceTrend = {
            labels: recent.map(a => new Date(a.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })),
            data: recent.map(a => parseFloat((a.distance / 1000).toFixed(2)))
        };

        const paceTrend = {
            labels: recent.map(a => new Date(a.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })),
            data: recent.map(a => {
                if (a.distance === 0) return 0;
                return parseFloat(((a.moving_time / 60) / (a.distance / 1000)).toFixed(2));
            })
        };

        const types = {};
        activities.forEach(a => { types[a.type] = (types[a.type] || 0) + 1; });
        const activityTypes = { labels: Object.keys(types), data: Object.values(types) };

        const weekly = {};
        activities.forEach(a => {
            const date = new Date(a.start_date);
            const weekNumber = Math.ceil((date.getDate()) / 7);
            const key = `Week ${weekNumber}`;
            weekly[key] = (weekly[key] || 0) + (a.distance / 1000);
        });
        const weeklyVolume = {
            labels: Object.keys(weekly).sort(),
            data: Object.keys(weekly).sort().map(k => parseFloat(weekly[k].toFixed(2)))
        };

        const hrZones = { "Zone 1": 0, "Zone 2": 0, "Zone 3": 0, "Zone 4": 0, "Zone 5": 0 };
        activities.forEach(a => {
            if (a.has_heartrate && a.average_heartrate) {
                const hr = a.average_heartrate;
                if (hr < 140) hrZones["Zone 1"]++;
                else if (hr < 155) hrZones["Zone 2"]++;
                else if (hr < 165) hrZones["Zone 3"]++;
                else if (hr < 180) hrZones["Zone 4"]++;
                else hrZones["Zone 5"]++;
            }
        });
        const hrDistribution = { labels: Object.keys(hrZones), data: Object.values(hrZones) };

        const efficiencyTrend = {
            labels: recent.map(a => new Date(a.start_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })),
            data: recent.map(a => {
                const effort = a.suffer_score || (a.average_heartrate ? a.average_heartrate / 2 : 50);
                return parseFloat((a.distance / 1000 / effort * 10).toFixed(2));
            })
        };

        res.json({ charts: { distanceTrend, paceTrend, activityTypes, weeklyVolume, hrDistribution, efficiencyTrend } });
        await storeActivities(activities);
    } catch (error) {
        console.error('Charts error:', error);
        res.status(500).json({ error: 'Failed to generate metrics' });
    }
};
