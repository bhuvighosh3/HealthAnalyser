const path = require('path');
const { runAgent, createStdioMcpToolset, LlmAgent, MODEL } = require('../services/adkService');
const { isCalendarConfigured } = require('../services/calendarMcpService');

// ── Config check endpoint ────────────────────────────────────────────────────
exports.calendarStatus = (req, res) => {
    res.json({ configured: isCalendarConfigured() });
};

// ── Schedule workouts into Google Calendar (ADK-powered) ─────────────────────
exports.schedule = async (req, res) => {
    if (!isCalendarConfigured()) {
        return res.status(400).json({
            error: 'Google Calendar not configured.',
            setup: [
                '1. Create OAuth 2.0 credentials (Desktop app) in Google Cloud Console',
                '2. Enable Google Calendar API',
                '3. Download the credentials JSON',
                '4. Add GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json to your .env',
                '5. Run: npx @cocal/google-calendar-mcp auth',
            ]
        });
    }

    const { weeklyTrainingPlan, durationWeeks = 4, startDate } = req.body;
    if (!weeklyTrainingPlan || !weeklyTrainingPlan.length) {
        return res.status(400).json({ error: 'weeklyTrainingPlan is required.' });
    }

    try {
        const start = startDate ? new Date(startDate) : new Date();
        // Align to next Monday
        const dayOfWeek = start.getDay();
        const daysToMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
        start.setDate(start.getDate() + daysToMonday);
        const startISO = start.toISOString().slice(0, 10);

        const systemInstruction = `You are a fitness scheduling assistant with access to the user's Google Calendar.
Your job is to schedule a personalised workout plan into their calendar, intelligently working around existing commitments.

Rules:
- Prefer early morning slots (06:00–08:30) or early evening (17:30–19:30)
- Rest days must NOT be scheduled
- Duration per workout: easy/rest=0 min, easy run=40 min, moderate=60 min, hard=75–90 min
- Add a clear title (e.g. "🏃 Easy Run – 5 km") and include workout details + purpose in the description
- If a preferred slot is busy, shift to the next available slot that day or the following morning
- After scheduling all workouts, provide a concise summary of what was created`;

        const userPrompt = `Please schedule the following weekly training plan into my Google Calendar.

Start date: ${startISO} (first Monday of the plan)
Number of weeks to schedule: ${durationWeeks}

Weekly Training Plan:
${weeklyTrainingPlan.map(d => `  ${d.day}: ${d.workout} | ${d.duration} | ${d.intensity} | Purpose: ${d.purpose}`).join('\n')}

Steps:
1. For each of the ${durationWeeks} weeks starting ${startISO}, map each training day to the correct calendar date
2. Check my calendar for free slots on each training day (skip rest days)
3. Create a calendar event for each workout in a free slot
4. Return a summary listing every event created (date, time, title) and any that couldn't be scheduled`;

        const calMcpToolset = createStdioMcpToolset(
            path.join(__dirname, '../node_modules/.bin/google-calendar-mcp'),
            { GOOGLE_OAUTH_CREDENTIALS: process.env.GOOGLE_OAUTH_CREDENTIALS || '' }
        );

        const scheduleAgent = new LlmAgent({
            name:        'schedule_agent',
            model:       MODEL,
            instruction: systemInstruction,
            tools:       [calMcpToolset],
        });

        console.log('[Schedule] Starting ADK calendar scheduling agent');
        const summary = await runAgent(scheduleAgent, userPrompt, [calMcpToolset]);

        console.log('[Schedule] Calendar scheduling complete');
        res.json({ summary });

    } catch (err) {
        console.error('[Schedule Error]', err.message);

        // Surface a friendly setup error if it's an auth/config problem
        if (err.message.includes('GOOGLE_OAUTH_CREDENTIALS') || err.message.includes('auth')) {
            return res.status(401).json({
                error: 'Google Calendar authentication failed.',
                hint: 'Run: npx @cocal/google-calendar-mcp auth  — then restart the server.'
            });
        }
        res.status(500).json({ error: 'Failed to schedule workouts: ' + err.message });
    }
};
