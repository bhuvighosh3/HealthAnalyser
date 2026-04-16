/**
 * Google Calendar OAuth Controller
 *
 * Handles the OAuth flow so each user connects their own Google account.
 */

const {
    getAuthUrl,
    handleCallback,
    isConnected,
    getConnectedEmail,
    disconnect,
    fetchUpcomingEvents,
    createEvent,
} = require('../services/googleOAuthService');

// ── Simple session ID from cookie ─────────────────────────────────────────────
function getSessionId(req, res) {
    let sid = req.cookies?.gcal_session;
    if (!sid) {
        sid = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        res.cookie('gcal_session', sid, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });
    }
    return sid;
}

// ── GET /auth/google-calendar ─────────────────────────────────────────────────
exports.startAuth = (req, res) => {
    try {
        const sessionId = getSessionId(req, res);
        const url = getAuthUrl(sessionId);
        res.redirect(url);
    } catch (err) {
        console.error('[GoogleAuth] startAuth error:', err.message);
        res.status(500).send(`<h2>⚠️ Setup Required</h2><p>${err.message}</p><a href="/">← Back</a>`);
    }
};

// ── GET /auth/google-calendar/callback ────────────────────────────────────────
exports.callback = async (req, res) => {
    const { code, state: sessionId, error } = req.query;

    if (error) {
        return res.send(`<h2>❌ Access Denied</h2><p>${error}</p><a href="/">← Back</a>`);
    }
    if (!code || !sessionId) {
        return res.status(400).send('Missing code or session.');
    }

    try {
        const email = await handleCallback(code, sessionId);
        res.cookie('gcal_session', sessionId, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });

        res.send(`<!DOCTYPE html><html><head><title>Connected</title>
        <style>
            body{font-family:Inter,sans-serif;background:#0a0f1e;color:#e2e8f0;
                 display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
            .card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
                  border-radius:16px;padding:2.5rem;text-align:center;max-width:420px}
            h2{color:#38bdf8;margin:0 0 .75rem}
            p{opacity:.75;margin:0 0 1.5rem}
            a{background:linear-gradient(135deg,#38bdf8,#34d399);color:#0a0f1e;padding:.6rem 1.4rem;
              border-radius:8px;text-decoration:none;font-weight:600;display:inline-block}
        </style>
        <script>
            if(window.opener){
                window.opener.postMessage({type:'GCAL_CONNECTED',email:'${email}'},'*');
                setTimeout(()=>window.close(),1500);
            } else { setTimeout(()=>window.location.href='/',2000); }
        </script></head>
        <body><div class="card">
            <h2>✅ Google Calendar Connected!</h2>
            <p>Signed in as <strong>${email}</strong><br>Redirecting back…</p>
            <a href="/">Go to Dashboard</a>
        </div></body></html>`);
    } catch (err) {
        console.error('[GoogleAuth] callback error:', err.message);
        res.status(500).send(`<h2>❌ Auth Failed</h2><p>${err.message}</p><a href="/">← Back</a>`);
    }
};

// ── GET /auth/google-calendar/status ─────────────────────────────────────────
exports.status = async (req, res) => {
    const sessionId = req.cookies?.gcal_session;
    const connected = await isConnected(sessionId);
    const email     = connected ? await getConnectedEmail(sessionId) : null;
    res.json({ connected, email });
};

// ── POST /auth/google-calendar/disconnect ─────────────────────────────────────
exports.disconnectCalendar = async (req, res) => {
    const sessionId = req.cookies?.gcal_session;
    if (sessionId) await disconnect(sessionId);
    res.json({ ok: true });
};

// ── GET /api/calendar/upcoming ───────────────────────────────────────────────
exports.upcomingEvents = async (req, res) => {
    const sessionId = req.cookies?.gcal_session;
    if (!sessionId || !(await isConnected(sessionId))) {
        return res.status(401).json({ error: 'Google Calendar not connected.', hint: 'Click "Connect Google Calendar" first.' });
    }
    const days = parseInt(req.query.days) || 14;
    try {
        const { events, email } = await fetchUpcomingEvents(sessionId, days);
        if (!events.length) {
            return res.json({ events: '', days, email, message: 'No upcoming events found.' });
        }
        // Group by date
        const grouped = {};
        for (const ev of events) {
            const start = ev.start.dateTime || ev.start.date;
            const date  = start.slice(0, 10);
            if (!grouped[date]) grouped[date] = [];
            const timeStr = ev.start.dateTime
                ? new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true })
                : 'All day';
            const endTime  = ev.end?.dateTime;
            const duration = (ev.start.dateTime && endTime)
                ? `${Math.round((new Date(endTime) - new Date(ev.start.dateTime)) / 60000)} min`
                : '';
            grouped[date].push(`  ${timeStr}${duration ? ` (${duration})` : ''} – ${ev.summary || 'Untitled'}`);
        }
        const formatted = Object.entries(grouped).map(([date, lines]) => {
            const d = new Date(date + 'T12:00:00');
            const label = d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
            return `${label}\n${lines.join('\n')}`;
        }).join('\n\n');
        res.json({ events: formatted, days, email });
    } catch (err) {
        console.error('[Calendar/upcoming]', err.message);
        if (err.message === 'NOT_CONNECTED') return res.status(401).json({ error: 'Session expired. Please reconnect.' });
        res.status(500).json({ error: 'Failed to fetch events: ' + err.message });
    }
};

// ── POST /api/calendar/schedule ──────────────────────────────────────────────
exports.scheduleWorkouts = async (req, res) => {
    const sessionId = req.cookies?.gcal_session;
    if (!sessionId || !(await isConnected(sessionId))) {
        return res.status(401).json({ error: 'Google Calendar not connected.', hint: 'Click "Connect Google Calendar" first.' });
    }

    const { weeklyTrainingPlan, durationWeeks = 4, startDate } = req.body;
    if (!weeklyTrainingPlan?.length) {
        return res.status(400).json({ error: 'weeklyTrainingPlan is required.' });
    }

    const email = await getConnectedEmail(sessionId);

    try {
        // Align to next Monday
        const start     = startDate ? new Date(startDate) : new Date();
        const dow       = start.getDay();
        const daysToMon = dow === 0 ? 1 : (8 - dow) % 7 || 7;
        start.setDate(start.getDate() + daysToMon);
        const startISO = start.toISOString().slice(0, 10);

        // Fetch existing events to check conflicts
        const { events: existingEvents } = await fetchUpcomingEvents(sessionId, durationWeeks * 7 + 7);
        const busyTimes = existingEvents.map(ev => ({
            start: ev.start.dateTime || ev.start.date,
            end:   ev.end?.dateTime  || ev.end?.date,
        }));

        const durationMap = { easy: 40, moderate: 60, hard: 80, interval: 85, long: 90, rest: 0 };
        const getDuration = (intensity = '', workout = '') => {
            const key = Object.keys(durationMap).find(k =>
                intensity.toLowerCase().includes(k) || workout.toLowerCase().includes(k)
            );
            return durationMap[key] || 60;
        };

        const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const created = [], skipped = [];

        for (let week = 0; week < durationWeeks; week++) {
            for (const session of weeklyTrainingPlan) {
                const intensity = (session.intensity || '').toLowerCase();
                if (intensity.includes('rest')) continue;

                const dayIndex = dayNames.findIndex(d =>
                    d.toLowerCase().startsWith(session.day.toLowerCase().slice(0, 3))
                );
                if (dayIndex === -1) continue;

                const sessionDate = new Date(startISO);
                sessionDate.setDate(sessionDate.getDate() + (week * 7) + ((dayIndex + 6) % 7));
                const dateStr = sessionDate.toISOString().slice(0, 10);

                const durationMin = getDuration(session.intensity, session.workout);
                const emoji = session.workout?.toLowerCase().includes('interval') ? '⚡'
                    : session.workout?.toLowerCase().includes('long') ? '🏃'
                    : session.workout?.toLowerCase().includes('easy') ? '🟢'
                    : session.workout?.toLowerCase().includes('strength') ? '💪' : '🏃';

                const title = `${emoji} ${session.workout}`;
                const description = `Intensity: ${session.intensity}\nPurpose: ${session.purpose}\n\nScheduled by AthleteIQ`;

                const slots = [
                    { hour: 6, minute: 30 },
                    { hour: 17, minute: 30 },
                    { hour: 7, minute: 0 },
                    { hour: 18, minute: 0 },
                ];

                // Naive datetime formatter — no timezone suffix so Google Calendar
                // uses the user's own calendar timezone instead of converting from UTC
                const fmt = (h, m, extraMin = 0) => {
                    const totalMin = h * 60 + m + extraMin;
                    const hh = Math.floor(totalMin / 60) % 24;
                    const mm = totalMin % 60;
                    return `${dateStr}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`;
                };

                let scheduled = false;
                for (const slot of slots) {
                    const startStr = fmt(slot.hour, slot.minute);
                    const endStr   = fmt(slot.hour, slot.minute, durationMin);

                    // For conflict detection use real Date objects (busyTimes are UTC ISO strings)
                    const startDT = new Date(`${dateStr}T${String(slot.hour).padStart(2,'0')}:${String(slot.minute).padStart(2,'0')}:00Z`);
                    const endDT   = new Date(startDT.getTime() + durationMin * 60 * 1000);

                    const conflict = busyTimes.some(b => {
                        if (!b.start || !b.end) return false;
                        return startDT < new Date(b.end) && endDT > new Date(b.start);
                    });

                    if (!conflict) {
                        await createEvent(sessionId, {
                            summary: title, description,
                            startDateTime: startStr,
                            endDateTime:   endStr,
                        });
                        created.push({
                            date: dateStr,
                            time: startDT.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true }),
                            title,
                        });
                        scheduled = true;
                        break;
                    }
                }
                if (!scheduled) skipped.push({ date: dateStr, title, reason: 'No free slot found' });
            }
        }

        const lines = [
            `📅 Scheduled ${created.length} workout(s) into ${email}'s Google Calendar\n`,
            ...created.map(e => `  ✅ ${e.date} ${e.time} – ${e.title}`),
        ];
        if (skipped.length) {
            lines.push(`\n⚠️ Could not schedule ${skipped.length} workout(s):`);
            lines.push(...skipped.map(e => `  ❌ ${e.date} – ${e.title} (${e.reason})`));
        }
        res.json({ summary: lines.join('\n') });

    } catch (err) {
        console.error('[Calendar/schedule]', err.message);
        if (err.message === 'NOT_CONNECTED') return res.status(401).json({ error: 'Session expired. Please reconnect.' });
        res.status(500).json({ error: 'Failed to schedule: ' + err.message });
    }
};

// ── POST /api/calendar/add-workout ───────────────────────────────────────────
exports.addWorkout = async (req, res) => {
    const sessionId = req.cookies?.gcal_session;
    if (!sessionId || !(await isConnected(sessionId))) {
        return res.status(401).json({ error: 'Google Calendar not connected.' });
    }
    const { title, date, startTime, durationMinutes = 60, description = '' } = req.body;
    if (!title || !date || !startTime) {
        return res.status(400).json({ error: 'title, date, and startTime are required.' });
    }
    try {
        const [h, m]   = startTime.split(':').map(Number);
        const endMin   = h * 60 + m + durationMinutes;
        const endStr   = `${date}T${String(Math.floor(endMin/60)%24).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}:00`;
        await createEvent(sessionId, { summary: title, description, startDateTime: `${date}T${startTime}:00`, endDateTime: endStr });
        res.json({ result: `✅ "${title}" added on ${date} at ${startTime}.` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add workout: ' + err.message });
    }
};
