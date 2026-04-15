/**
 * Google Calendar OAuth Service
 *
 * Manages per-user Google OAuth tokens stored in SQLite.
 * Each user authenticates with their own Google account —
 * tokens are stored and refreshed independently per user session.
 */

const { google } = require('googleapis');

// In-memory token store keyed by sessionId
// { [sessionId]: { access_token, refresh_token, expiry_date, email } }
const tokenStore = new Map();

/**
 * Build an OAuth2 client using environment credentials.
 */
function makeOAuthClient() {
    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google-calendar/callback';

    if (!clientId || !clientSecret) {
        throw new Error(
            'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.\n' +
            'Create OAuth 2.0 credentials at https://console.cloud.google.com → APIs & Services → Credentials'
        );
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate the Google OAuth consent URL for a given session.
 */
function getAuthUrl(sessionId) {
    const oauth2Client = makeOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt:      'consent',   // always get a refresh token
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        state: sessionId,         // passed back in callback so we know which session
    });
}

/**
 * Exchange an auth code for tokens and store them for this session.
 * Returns the user's email address.
 */
async function handleCallback(code, sessionId) {
    const oauth2Client = makeOAuthClient();
    const { tokens }   = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch the user's email
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email;

    tokenStore.set(sessionId, {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date:   tokens.expiry_date,
        email,
    });

    console.log(`✅ Google Calendar connected for ${email} (session: ${sessionId})`);
    return email;
}

/**
 * Get a ready-to-use authenticated Google Calendar client for a session.
 * Automatically refreshes expired tokens.
 */
async function getCalendarClient(sessionId) {
    const stored = tokenStore.get(sessionId);
    if (!stored) {
        throw new Error('NOT_CONNECTED');
    }

    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials({
        access_token:  stored.access_token,
        refresh_token: stored.refresh_token,
        expiry_date:   stored.expiry_date,
    });

    // Auto-refresh if expired
    oauth2Client.on('tokens', (newTokens) => {
        if (newTokens.access_token) {
            stored.access_token = newTokens.access_token;
            if (newTokens.expiry_date) stored.expiry_date = newTokens.expiry_date;
            tokenStore.set(sessionId, stored);
            console.log(`🔄 Google token auto-refreshed for ${stored.email}`);
        }
    });

    return { client: oauth2Client, email: stored.email };
}

/**
 * Check if a session has a connected Google Calendar.
 */
function isConnected(sessionId) {
    return tokenStore.has(sessionId);
}

/**
 * Get the connected email for a session (or null).
 */
function getConnectedEmail(sessionId) {
    return tokenStore.get(sessionId)?.email || null;
}

/**
 * Disconnect a session's Google Calendar.
 */
function disconnect(sessionId) {
    tokenStore.delete(sessionId);
}

/**
 * Fetch upcoming events directly via Google Calendar API (no MCP needed).
 */
async function fetchUpcomingEvents(sessionId, days = 14) {
    const { client, email } = await getCalendarClient(sessionId);
    const calendar = google.calendar({ version: 'v3', auth: client });

    const now   = new Date();
    const until = new Date(now);
    until.setDate(until.getDate() + days);

    const response = await calendar.events.list({
        calendarId:   'primary',
        timeMin:      now.toISOString(),
        timeMax:      until.toISOString(),
        singleEvents: true,
        orderBy:      'startTime',
        maxResults:   50,
    });

    const events = response.data.items || [];
    return { events, email };
}

/**
 * Create a single calendar event via Google Calendar API.
 */
async function createEvent(sessionId, { summary, description, startDateTime, endDateTime }) {
    const { client } = await getCalendarClient(sessionId);
    const calendar   = google.calendar({ version: 'v3', auth: client });

    const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: {
            summary,
            description,
            start: { dateTime: startDateTime, timeZone: 'America/New_York' },
            end:   { dateTime: endDateTime,   timeZone: 'America/New_York' },
        },
    });

    return response.data;
}

module.exports = {
    getAuthUrl,
    handleCallback,
    getCalendarClient,
    isConnected,
    getConnectedEmail,
    disconnect,
    fetchUpcomingEvents,
    createEvent,
};
