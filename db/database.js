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
            INSERT OR REPLACE INTO activities
                (id, name, type, sport_type, workout_type,
                 start_date, start_date_local, timezone,
                 distance_m, moving_time_s, elapsed_time_s,
                 elevation_gain_m, elev_high_m, elev_low_m,
                 average_speed_ms, max_speed_ms,
                 average_heartrate, max_heartrate, has_heartrate,
                 suffer_score, pr_count, achievement_count,
                 kudos_count, comment_count, athlete_count, photo_count,
                 trainer, commute, manual,
                 visibility, gear_id, device_name,
                 location_city, location_state, location_country,
                 start_latlng, synced_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
            a.id,
            a.name,
            a.type,
            a.sport_type         || a.type,
            a.workout_type       ?? null,
            a.start_date,
            a.start_date_local,
            a.timezone           ?? null,
            a.distance,
            a.moving_time,
            a.elapsed_time,
            a.total_elevation_gain,
            a.elev_high          ?? null,
            a.elev_low           ?? null,
            a.average_speed,
            a.max_speed,
            a.average_heartrate  ?? null,
            a.max_heartrate      ?? null,
            a.has_heartrate      ? 1 : 0,
            a.suffer_score       ?? null,
            a.pr_count           ?? 0,
            a.achievement_count  ?? 0,
            a.kudos_count        ?? 0,
            a.comment_count      ?? 0,
            a.athlete_count      ?? 0,
            a.photo_count        ?? 0,
            a.trainer            ? 1 : 0,
            a.commute            ? 1 : 0,
            a.manual             ? 1 : 0,
            a.visibility         ?? null,
            a.gear_id            ?? null,
            a.device_name        ?? null,
            a.location_city      ?? null,
            a.location_state     ?? null,
            a.location_country   ?? null,
            Array.isArray(a.start_latlng) ? JSON.stringify(a.start_latlng) : null,
            now,
        ]);
    }
}

async function storeAthlete(a) {
    await runSQL(`
        INSERT OR REPLACE INTO athlete
            (id, username, firstname, lastname, bio, city, state, country, sex,
             profile_medium, profile, premium, summit, created_at, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
        a.id,
        a.username        ?? null,
        a.firstname,
        a.lastname,
        (typeof a.bio === 'string' ? a.bio : null),
        a.city            ?? null,
        a.state           ?? null,
        a.country         ?? null,
        a.sex             ?? null,
        a.profile_medium  ?? null,
        a.profile         ?? a.profile_medium ?? null,
        a.premium         ? 1 : 0,
        a.summit          ? 1 : 0,
        a.created_at      ?? null,
        new Date().toISOString(),
    ]);
}

async function initDatabase() {
    // ── run_stats ──────────────────────────────────────────────────────────────
    await runSQL(`
        CREATE TABLE IF NOT EXISTS run_stats (
            period           TEXT PRIMARY KEY,
            run_count        INTEGER,
            distance_m       REAL,
            moving_time_s    INTEGER,
            elevation_gain_m REAL
        )
    `);

    // ── activities (full schema) ───────────────────────────────────────────────
    await runSQL(`
        CREATE TABLE IF NOT EXISTS activities (
            id                  INTEGER PRIMARY KEY,
            name                TEXT,
            type                TEXT,
            sport_type          TEXT,
            workout_type        INTEGER,
            start_date          TEXT,
            start_date_local    TEXT,
            timezone            TEXT,
            distance_m          REAL,
            moving_time_s       INTEGER,
            elapsed_time_s      INTEGER,
            elevation_gain_m    REAL,
            elev_high_m         REAL,
            elev_low_m          REAL,
            average_speed_ms    REAL,
            max_speed_ms        REAL,
            average_heartrate   REAL,
            max_heartrate       REAL,
            has_heartrate       INTEGER,
            suffer_score        INTEGER,
            pr_count            INTEGER,
            achievement_count   INTEGER,
            kudos_count         INTEGER,
            comment_count       INTEGER,
            athlete_count       INTEGER,
            photo_count         INTEGER,
            trainer             INTEGER,
            commute             INTEGER,
            manual              INTEGER,
            visibility          TEXT,
            gear_id             TEXT,
            device_name         TEXT,
            location_city       TEXT,
            location_state      TEXT,
            location_country    TEXT,
            start_latlng        TEXT,
            synced_at           TEXT
        )
    `);

    // Migrate older DBs — add columns that didn't exist before (silent no-op if already present)
    const newCols = [
        ['workout_type',      'INTEGER'],
        ['timezone',          'TEXT'],
        ['elev_high_m',       'REAL'],
        ['elev_low_m',        'REAL'],
        ['has_heartrate',     'INTEGER'],
        ['pr_count',          'INTEGER'],
        ['achievement_count', 'INTEGER'],
        ['comment_count',     'INTEGER'],
        ['athlete_count',     'INTEGER'],
        ['photo_count',       'INTEGER'],
        ['manual',            'INTEGER'],
        ['visibility',        'TEXT'],
        ['gear_id',           'TEXT'],
        ['device_name',       'TEXT'],
        ['location_city',     'TEXT'],
        ['location_state',    'TEXT'],
        ['location_country',  'TEXT'],
        ['start_latlng',      'TEXT'],
    ];
    for (const [col, type] of newCols) {
        await runSQL(`ALTER TABLE activities ADD COLUMN ${col} ${type}`).catch(() => {});
    }

    // ── athlete (full schema) ─────────────────────────────────────────────────
    await runSQL(`
        CREATE TABLE IF NOT EXISTS athlete (
            id              INTEGER PRIMARY KEY,
            username        TEXT,
            firstname       TEXT,
            lastname        TEXT,
            bio             TEXT,
            city            TEXT,
            state           TEXT,
            country         TEXT,
            sex             TEXT,
            profile_medium  TEXT,
            profile         TEXT,
            premium         INTEGER,
            summit          INTEGER,
            created_at      TEXT,
            fetched_at      TEXT
        )
    `);
    for (const [col, type] of [['username','TEXT'],['bio','TEXT'],['summit','INTEGER'],['profile','TEXT']]) {
        await runSQL(`ALTER TABLE athlete ADD COLUMN ${col} ${type}`).catch(() => {});
    }

    // ── nutrition_vectors ─────────────────────────────────────────────────────
    await runSQL(`
        CREATE TABLE IF NOT EXISTS nutrition_vectors (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_category  TEXT    NOT NULL,
            topic_label    TEXT,
            content_text   TEXT    NOT NULL,
            source_title   TEXT,
            embedding_json TEXT    NOT NULL,
            created_at     TEXT    NOT NULL
        )
    `);
    await runSQL(`CREATE INDEX IF NOT EXISTS idx_nv_category ON nutrition_vectors(goal_category)`);
    console.log('✅ nutrition_vectors table ready');

    // ── Clear stale per-athlete data before repopulating ──────────────────────
    // Without this, switching profiles leaves the previous athlete's activities
    // in the table (different IDs so INSERT OR REPLACE won't remove them).
    try {
        await runSQL('DELETE FROM activities');
        await runSQL('DELETE FROM athlete');
        await runSQL('DELETE FROM run_stats');
    } catch (_) {}

    // ── Populate from Strava ───────────────────────────────────────────────────
    try {
        if (!tokens.ACCESS_TOKEN) return;

        const athlete = await fetchFromStrava('/athlete');
        await storeAthlete(athlete);

        const stats = await fetchFromStrava(`/athletes/${athlete.id}/stats`);

        // Fetch last 28 days + up to 200 activities for richer context
        const fourWeeksAgo = Math.floor(Date.now() / 1000) - (28 * 24 * 60 * 60);
        const [recentActivities, allActivities] = await Promise.all([
            fetchFromStrava(`/athlete/activities?per_page=200&after=${fourWeeksAgo}`),
            fetchFromStrava(`/athlete/activities?per_page=200`),
        ]);

        // Merge: recent first, deduplicated by id
        const seen = new Set();
        const merged = [];
        for (const a of [...recentActivities, ...allActivities]) {
            if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
        }

        await storeActivities(merged);

        const runs = recentActivities.filter(a => RUN_TYPES.has(a.type));
        const recent = {
            count:          runs.length,
            distance:       runs.reduce((s, a) => s + a.distance, 0),
            moving_time:    runs.reduce((s, a) => s + a.moving_time, 0),
            elevation_gain: runs.reduce((s, a) => s + (a.total_elevation_gain || 0), 0),
        };

        const y = stats.ytd_run_totals || {};
        const al = stats.all_run_totals || {};

        const stmt = db.prepare('INSERT OR REPLACE INTO run_stats VALUES (?, ?, ?, ?, ?)');
        stmt.run('recent',   recent.count,   recent.distance,   recent.moving_time,   recent.elevation_gain);
        stmt.run('ytd',      y.count || 0,   y.distance || 0,   y.moving_time || 0,   y.elevation_gain || 0);
        stmt.run('all_time', al.count || 0,  al.distance || 0,  al.moving_time || 0,  al.elevation_gain || 0);
        stmt.finalize();

        console.log(`✅ DB populated — ${merged.length} activities stored, recent runs: ${recent.count}, ytd: ${y.count || 0}`);

        writeMcpSnapshot({
            refreshedAt:        new Date().toISOString(),
            athlete,
            stats,
            recentActivities:   merged,
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
