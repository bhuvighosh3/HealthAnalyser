require('dotenv').config();

// Force stravaService to read fresh env vars after dotenv loads
// (module cache means process.env must be set before first require)
const { tokens, updateEnv } = require('./services/stravaService');
updateEnv({
    STRAVA_ACCESS_TOKEN:  process.env.STRAVA_ACCESS_TOKEN,
    STRAVA_REFRESH_TOKEN: process.env.STRAVA_REFRESH_TOKEN,
    STRAVA_EXPIRES_AT:    process.env.STRAVA_EXPIRES_AT,
    STRAVA_CLIENT_ID:     process.env.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
});

const express = require('express');
const cors    = require('cors');
const cookieParser = require('cookie-parser');
const { initDatabase } = require('./db/database');
const { authorize, exchangeToken } = require('./controllers/stravaController');
const googleCalendarController = require('./controllers/googleCalendarController');
const apiRoutes = require('./routes/apiRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ credentials: true, origin: true }));
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// Strava OAuth
app.get('/auth',           authorize);
app.get('/exchange_token', exchangeToken);

// Google Calendar OAuth (must be top-level routes, not under /api)
app.get('/auth/google-calendar',          googleCalendarController.startAuth);
app.get('/auth/google-calendar/callback', googleCalendarController.callback);

// API Routes
app.use('/api', apiRoutes);

app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    await initDatabase();
});
