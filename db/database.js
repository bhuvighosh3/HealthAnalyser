const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { fetchFromStrava, tokens } = require('../services/stravaService');

const MCP_SNAPSHOT_PATH = path.join(__dirname, '../public/strava_mcp_data.json');

function writeMcpSnapshot(data) {
    try {
        fs.writeFileSync(MCP_SNAPSHOT_PATH, JSON.stringify(data, null, 2));
        console.log('✅ strava_mcp_data.json updated');
    } catch (err) {
        console.error('Failed to write MCP snapshot:', err.message);
    }
}

const db = new sqlite3.Database('./health_data.db', err => {
    if (err) console.error('Failed to open DB:', err.message);
    else console.log('✅ SQLite DB opened: health_data.db');
});

const runSQL = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
});

const allSQL = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

const RUN_TYPES = new Set(['Run', 'VirtualRun', 'TrailRun', 'Treadmill', 'Hike']);

async function storeActivities(activities) {
    if (!Array.isArray(activities)) return;
    const now = new Date().toISOString();
    for (const a of activities) {
        await runSQL(`
            INSERT OR REPLACE INTO activities VALUES
            (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            a.id, a.name, a.type, a.sport_type || a.type,
            a.start_date, a.start_date_local,
            a.distance, a.moving_time, a.elapsed_time,
            a.total_elevation_gain, a.average_speed, a.max_speed,
            a.average_heartrate ?? null, a.max_heartrate ?? null,
            a.suffer_score ?? null, a.kudos_count,
            a.trainer ? 1 : 0, a.commute ? 1 : 0,
            now,
        ]);
    }
}

async function storeAthlete(a) {
    await runSQL(`
        INSERT OR REPLACE INTO athlete VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
        a.id, a.firstname, a.lastname,
        a.city, a.state, a.country, a.sex,
        a.profile_medium,
        a.premium ? 1 : 0,
        a.created_at, a.updated_at,
        new Date().toISOString(),
    ]);
}

async function initDatabase() {
    await runSQL(`
        CREATE TABLE IF NOT EXISTS run_stats (
            period        TEXT PRIMARY KEY,
            run_count     INTEGER,
            distance_m    REAL,
            moving_time_s INTEGER,
            elevation_gain_m REAL
        )
    `);
    await runSQL(`
        CREATE TABLE IF NOT EXISTS activities (
            id                    INTEGER PRIMARY KEY,
            name                  TEXT,
            type                  TEXT,
            sport_type            TEXT,
            start_date            TEXT,
            start_date_local      TEXT,
            distance_m            REAL,
            moving_time_s         INTEGER,
            elapsed_time_s        INTEGER,
            elevation_gain_m      REAL,
            average_speed_ms      REAL,
            max_speed_ms          REAL,
            average_heartrate     REAL,
            max_heartrate         REAL,
            suffer_score          INTEGER,
            kudos_count           INTEGER,
            trainer               INTEGER,
            commute               INTEGER,
            synced_at             TEXT
        )
    `);
    await runSQL(`
        CREATE TABLE IF NOT EXISTS athlete (
            id              INTEGER PRIMARY KEY,
            firstname       TEXT,
            lastname        TEXT,
            city            TEXT,
            state           TEXT,
            country         TEXT,
            sex             TEXT,
            profile_medium  TEXT,
            premium         INTEGER,
            created_at      TEXT,
            updated_at      TEXT,
            fetched_at      TEXT
        )
    `);

    try {
        if (!tokens.ACCESS_TOKEN) return;

        const athlete = await fetchFromStrava('/athlete');
        await storeAthlete(athlete);

        const stats = await fetchFromStrava(`/athletes/${athlete.id}/stats`);

        const fourWeeksAgo = Math.floor(Date.now() / 1000) - (28 * 24 * 60 * 60);
        const recentActivities = await fetchFromStrava(`/athlete/activities?per_page=100&after=${fourWeeksAgo}`);
        await storeActivities(recentActivities);

        const runs = recentActivities.filter(a => RUN_TYPES.has(a.type));
        const recent = {
            count:          runs.length,
            distance:       runs.reduce((s, a) => s + a.distance, 0),
            moving_time:    runs.reduce((s, a) => s + a.moving_time, 0),
            elevation_gain: runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
        };

        const y = stats.ytd_run_totals    || {};
        const a = stats.all_run_totals    || {};

        const stmt = db.prepare('INSERT OR REPLACE INTO run_stats VALUES (?, ?, ?, ?, ?)');
        stmt.run('recent',   recent.count,              recent.distance,       recent.moving_time,    recent.elevation_gain);
        stmt.run('ytd',      y.count || 0,              y.distance || 0,       y.moving_time || 0,    y.elevation_gain || 0);
        stmt.run('all_time', a.count || 0,              a.distance || 0,       a.moving_time || 0,    a.elevation_gain || 0);
        stmt.finalize();

        console.log(`✅ DB populated — recent runs: ${recent.count}, ytd: ${y.count || 0}`);

        writeMcpSnapshot({
            refreshedAt:        new Date().toISOString(),
            athlete,
            stats,
            recentActivities,
        });
    } catch (err) {
        console.error('Failed to populate DB:', err.message);
    }
}

module.exports = {
    db,
    runSQL,
    allSQL,
    storeActivities,
    initDatabase,
    RUN_TYPES
};
