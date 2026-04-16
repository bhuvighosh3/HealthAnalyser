/**
 * Google Calendar OAuth Service
 *
 * Manages per-user Google OAuth tokens stored in Firestore so they survive
 * Cloud Run instance restarts and page refreshes.
 */

const { google }    = require('googleapis');
const { Firestore } = require('@google-cloud/firestore');

const db         = new Firestore({ projectId: process.env.GCP_PROJECT_ID || 'healthmonitor-493021' });
const COLLECTION = 'gcal_sessions';

// ── OAuth client ──────────────────────────────────────────────────────────────

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

// ── Firestore helpers ─────────────────────────────────────────────────────────

async function saveSession(sessionId, data) {
    await db.collection(COLLECTION).doc(sessionId).set({ ...data, updatedAt: new Date() });
}

async function loadSession(sessionId) {
    const doc = await db.collection(COLLECTION).doc(sessionId).get();
    return doc.exists ? doc.data() : null;
}

async function deleteSession(sessionId) {
    await db.collection(COLLECTION).doc(sessionId).delete();
}

// ── Public API ────────────────────────────────────────────────────────────────

function getAuthUrl(sessionId) {
    const oauth2Client = makeOAuthClient();
    return oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt:      'consent',
        scope: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        state: sessionId,
    });
}

async function handleCallback(code, sessionId) {
    const oauth2Client   = makeOAuthClient();
    const { tokens }     = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email;

    await saveSession(sessionId, {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date:   tokens.expiry_date,
        email,
    });

    console.log(`✅ Google Calendar connected for ${email} (session: ${sessionId})`);
    return email;
}

async function getCalendarClient(sessionId) {
    const stored = await loadSession(sessionId);
    if (!stored) throw new Error('NOT_CONNECTED');

    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials({
        access_token:  stored.access_token,
        refresh_token: stored.refresh_token,
        expiry_date:   stored.expiry_date,
    });

    // Persist refreshed tokens back to Firestore
    oauth2Client.on('tokens', async (newTokens) => {
        if (newTokens.access_token) {
            stored.access_token = newTokens.access_token;
            if (newTokens.expiry_date) stored.expiry_date = newTokens.expiry_date;
            await saveSession(sessionId, stored);
            console.log(`🔄 Google token auto-refreshed for ${stored.email}`);
        }
    });

    return { client: oauth2Client, email: stored.email };
}

async function isConnected(sessionId) {
    if (!sessionId) return false;
    const stored = await loadSession(sessionId);
    return !!stored;
}

async function getConnectedEmail(sessionId) {
    if (!sessionId) return null;
    const stored = await loadSession(sessionId);
    return stored?.email || null;
}

async function disconnect(sessionId) {
    if (sessionId) await deleteSession(sessionId);
}

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

    return { events: response.data.items || [], email };
}

async function createEvent(sessionId, { summary, description, startDateTime, endDateTime }) {
    const { client } = await getCalendarClient(sessionId);
    const calendar   = google.calendar({ version: 'v3', auth: client });

    const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: {
            summary,
            description,
            start: { dateTime: startDateTime },
            end:   { dateTime: endDateTime },
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
