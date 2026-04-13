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
            const [recentActs, allActs] = await Promise.all([
                fetchFromStrava(`/athlete/activities?per_page=200&after=${fourWeeksAgo}`),
                fetchFromStrava(`/athlete/activities?per_page=200`),
            ]);
            await storeActivities(recentActs);

            const runs = recentActs.filter(a => RUN_TYPES.has(a.type));
            const allRuns = allActs.filter(a => RUN_TYPES.has(a.type));

            stats.recent_run_totals = {
                count:          runs.length,
                distance:       runs.reduce((s, a) => s + a.distance, 0),
                moving_time:    runs.reduce((s, a) => s + a.moving_time, 0),
                elevation_gain: runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
            };

            // ── Consistency ───────────────────────────────────────────────────
            const runWeeks = new Set(runs.map(a => {
                const d = new Date(a.start_date);
                const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
                return ws.toISOString().slice(0, 10);
            }));
            const consistencyScore = Math.min(100, Math.round((runWeeks.size / 4) * 100));

            // ── Suffer score ──────────────────────────────────────────────────
            const sufferScores = runs.filter(r => r.suffer_score > 0).map(r => r.suffer_score);
            const avgSufferScore = sufferScores.length
                ? Math.round(sufferScores.reduce((s, v) => s + v, 0) / sufferScores.length)
                : null;

            // ── Best pace (min/km) ────────────────────────────────────────────
            const paceRuns = allRuns.filter(a => a.distance > 1000 && a.moving_time > 0);
            let bestPace = null, bestPaceActivity = null;
            for (const a of paceRuns) {
                const p = (a.moving_time / 60) / (a.distance / 1000);
                if (!bestPace || p < bestPace) { bestPace = p; bestPaceActivity = a; }
            }
            const fmtPace = (p) => {
                if (!p) return null;
                const m = Math.floor(p), s = Math.round((p - m) * 60);
                return `${m}:${String(s).padStart(2,'0')}`;
            };

            // ── Heart rate ────────────────────────────────────────────────────
            const hrRuns = allRuns.filter(a => a.average_heartrate);
            const avgHR  = hrRuns.length
                ? Math.round(hrRuns.reduce((s, a) => s + a.average_heartrate, 0) / hrRuns.length)
                : null;
            const maxHR  = hrRuns.length
                ? Math.round(Math.max(...hrRuns.map(a => a.max_heartrate || a.average_heartrate)))
                : null;

            // ── Longest run ───────────────────────────────────────────────────
            const longestRun = allRuns.reduce((best, a) =>
                (!best || a.distance > best.distance) ? a : best, null);

            // ── PRs & achievements ────────────────────────────────────────────
            const totalPRs          = allActs.reduce((s, a) => s + (a.pr_count || 0), 0);
            const totalAchievements = allActs.reduce((s, a) => s + (a.achievement_count || 0), 0);

            // ── Avg weekly km (last 4 weeks) ──────────────────────────────────
            const avgWeeklyKm = parseFloat((
                runs.reduce((s, a) => s + a.distance, 0) / 1000 / 4
            ).toFixed(1));

            // ── Sport breakdown ───────────────────────────────────────────────
            const sportBreakdown = {};
            for (const a of allActs) sportBreakdown[a.type] = (sportBreakdown[a.type] || 0) + 1;

            // ── Elevation (YTD + recent 4w) ───────────────────────────────────
            const recentElevation = runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0);

            stats.computed = {
                consistencyScore,
                avgSufferScore,
                bestPace:          fmtPace(bestPace),
                bestPaceActivity:  bestPaceActivity ? {
                    name: bestPaceActivity.name,
                    date: bestPaceActivity.start_date?.slice(0, 10),
                    distKm: parseFloat((bestPaceActivity.distance / 1000).toFixed(2)),
                } : null,
                avgHR,
                maxHR,
                longestRun: longestRun ? {
                    name:   longestRun.name,
                    date:   longestRun.start_date?.slice(0, 10),
                    distKm: parseFloat((longestRun.distance / 1000).toFixed(2)),
                } : null,
                totalPRs,
                totalAchievements,
                avgWeeklyKm,
                recentElevation: Math.round(recentElevation),
                sportBreakdown,
            };
        } catch (e) {
            console.error('[Stats] Failed to compute rich stats:', e.message);
            stats.computed = {};
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
