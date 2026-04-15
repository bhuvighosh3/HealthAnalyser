/**
 * Google Calendar Service (Vertex AI / Google ADK)
 *
 * Uses the same Google ADK + Vertex AI setup as the rest of the project.
 * Connects to Google Calendar via the @cocal/google-calendar-mcp stdio server,
 * authenticated with a local OAuth credentials file.
 *
 * Required .env vars:
 *   GOOGLE_OAUTH_CREDENTIALS  – path to your gcp-oauth.keys.json file
 *   GCP_PROJECT_ID            – your Google Cloud project ID
 *   GCP_LOCATION              – e.g. us-central1
 */

const path = require('path');
const { runAgent, createStdioMcpToolset, LlmAgent, MODEL } = require('./adkService');

/** Path to the google-calendar-mcp binary installed by npm */
const CALENDAR_MCP_BIN = path.join(__dirname, '../node_modules/.bin/google-calendar-mcp');

/**
 * Build a fresh MCPToolset for Google Calendar (must be closed after each call).
 */
function makeCalendarToolset() {
    return createStdioMcpToolset(CALENDAR_MCP_BIN, {
        GOOGLE_OAUTH_CREDENTIALS: process.env.GOOGLE_OAUTH_CREDENTIALS || '',
    });
}

/**
 * Fetch upcoming events from Google Calendar for the next N days.
 * @param {number} days
 * @returns {Promise<string>}
 */
async function fetchUpcomingEvents(days = 14, userEmail = null) {
    // Format as YYYY-MM-DDTHH:MM:SS (no timezone suffix — what the MCP expects)
    const fmt   = (d) => d.toISOString().slice(0, 19);
    const now   = new Date();
    const until = new Date(now);
    until.setDate(until.getDate() + days);
    const timeMin = fmt(now);
    const timeMax = fmt(until);

    const instruction = `You are a calendar assistant with access to the user's Google Calendar.
Use the calendar tools to list events. 
IMPORTANT: Always use calendarId "primary" — never use an email address as the calendar ID.
Always use this exact time format for timeMin and timeMax: YYYY-MM-DDTHH:MM:SS (no Z, no timezone offset).
Format each event in your response as:  DATE TIME – TITLE (DURATION)
Group events by date. If there are no events, say so clearly.`;

    const prompt = `List all events in my Google Calendar.
Use calendarId "primary", timeMin "${timeMin}", timeMax "${timeMax}".
Do not use any email address as the calendarId — only use "primary".
Show date, time, title, and duration for each event. Group by date.`;

    const toolset = makeCalendarToolset();
    const agent   = new LlmAgent({
        name:        'calendar_viewer_agent',
        model:       MODEL,
        instruction,
        tools:       [toolset],
    });

    return await runAgent(agent, prompt, [toolset]);
}

/**
 * Schedule a full training plan into Google Calendar.
 * Checks existing events and finds free slots automatically.
 *
 * @param {Array}   weeklyTrainingPlan  Array of { day, workout, duration, intensity, purpose }
 * @param {number}  durationWeeks       How many weeks to schedule
 * @param {string|null} startDate       ISO date string (optional); defaults to next Monday
 * @returns {Promise<string>}           Summary of scheduled events
 */
async function scheduleWorkouts(weeklyTrainingPlan, durationWeeks = 4, startDate = null, userEmail = null) {
    // Align to next Monday
    const start      = startDate ? new Date(startDate) : new Date();
    const dayOfWeek  = start.getDay();
    const daysToMon  = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
    start.setDate(start.getDate() + daysToMon);
    const startISO = start.toISOString().slice(0, 10);

    const instruction = `You are a fitness scheduling assistant with access to the user's Google Calendar.
Your job is to schedule a personalised workout plan, intelligently working around existing commitments.

IMPORTANT tool usage rules:
- Always use calendarId "primary" — never use an email address as the calendar ID
- Always use this exact time format: YYYY-MM-DDTHH:MM:SS (no Z, no timezone offset)

Scheduling rules:
- Prefer early morning slots (06:00–08:30) or early evening (17:30–19:30)
- Rest days must NOT be scheduled — skip them entirely
- Durations: easy run = 40 min, moderate = 60 min, hard/interval = 75–90 min
- Event title format: emoji + type + details  e.g. "🏃 Easy Run – 5 km"
- Include workout purpose in the event description
- If a preferred slot is busy, shift to the next free slot that day or the following morning
- After scheduling all workouts, return a clean summary table: date | time | workout title`;

    const fmt = (d) => d.toISOString().slice(0, 19);

    const prompt = `Please schedule my training plan into Google Calendar.

${userEmail ? `Calendar owner: ${userEmail} (but use calendarId "primary" in all tool calls)\n` : ''}Plan start: ${startISO} (this is a Monday — week 1 begins here)
Weeks to schedule: ${durationWeeks}

Weekly Training Plan:
${weeklyTrainingPlan.map(d =>
    `  ${d.day}: ${d.workout} | ${d.duration || 'auto'} | Intensity: ${d.intensity} | Purpose: ${d.purpose}`
).join('\n')}

Steps:
1. For each of the ${durationWeeks} weeks starting ${startISO}, calculate the exact calendar date for each training day
2. Check existing events using calendarId "primary" and times in YYYY-MM-DDTHH:MM:SS format (no Z)
3. Create a workout event in a free slot for every non-rest day using calendarId "primary"
4. Return a summary listing every event created (date, time, title) and any that could not be scheduled`;

    const toolset = makeCalendarToolset();
    const agent   = new LlmAgent({
        name:        'schedule_workouts_agent',
        model:       MODEL,
        instruction,
        tools:       [toolset],
    });

    const result = await runAgent(agent, prompt, [toolset]);
    if (!result) {
        throw new Error('No response from scheduling agent. Check your Google Calendar MCP setup.');
    }
    return result;
}

/**
 * Add a single custom workout event to Google Calendar.
 *
 * @param {object} workout  { title, date, startTime, durationMinutes, description }
 * @returns {Promise<string>}
 */
async function addSingleWorkout({ title, date, startTime, durationMinutes = 60, description = '' }) {
    const instruction = `You are a calendar assistant. Create calendar events exactly as specified and confirm when done.`;

    const prompt = `Create a workout event in my Google Calendar with these details:
Title: ${title}
Date: ${date}
Start time: ${startTime}
Duration: ${durationMinutes} minutes
Description: ${description}

Create the event and confirm it was added successfully.`;

    const toolset = makeCalendarToolset();
    const agent   = new LlmAgent({
        name:        'add_workout_agent',
        model:       MODEL,
        instruction,
        tools:       [toolset],
    });

    return await runAgent(agent, prompt, [toolset]);
}

/**
 * Check if Google Calendar MCP is configured (credentials file exists in env).
 */
function isCalendarMcpConfigured() {
    return !!process.env.GOOGLE_OAUTH_CREDENTIALS;
}

module.exports = {
    fetchUpcomingEvents,
    scheduleWorkouts,
    addSingleWorkout,
    isCalendarMcpConfigured,
};
