require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const { initDatabase } = require('./db/database');
const { authorize, exchangeToken } = require('./controllers/stravaController');
const { requestTokenStore, PROFILE_TOKENS, ensureValidProfileToken, warmProfileTokensFromFirestore } = require('./services/stravaService');
const googleCalendarController = require('./controllers/googleCalendarController');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ credentials: true, origin: true }));
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// Strava OAuth
app.get('/auth', authorize);
app.get('/exchange_token', exchangeToken);

// Google Calendar OAuth (top-level — must be outside /api prefix)
app.get('/auth/google-calendar',          googleCalendarController.startAuth);
app.get('/auth/google-calendar/callback', googleCalendarController.callback);

// Per-request profile token resolution — reads X-Profile header and injects
// the correct token set into AsyncLocalStorage so every downstream Strava call
// uses the right credentials, regardless of which Cloud Run instance handles it.
app.use('/api', (req, res, next) => {
    const profile = (req.headers['x-profile'] || '').toLowerCase();
    const profileTokens = PROFILE_TOKENS[profile];
    if (profileTokens && profileTokens.ACCESS_TOKEN) {
        requestTokenStore.run(profileTokens, next);
    } else {
        next(); // 'own' credentials — use global tokens set by /api/auth/configure
    }
});

// API Routes
app.use('/api', apiRoutes);

app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    // 1. Pull the latest rotated tokens from Firestore (beats env vars on cold starts)
    await warmProfileTokensFromFirestore();
    // 2. Refresh any profile token expiring within the hour (all three profiles)
    await Promise.allSettled(
        Object.entries(PROFILE_TOKENS).map(([name, t]) =>
            ensureValidProfileToken(t).catch(e =>
                console.warn(`[Startup] Token pre-warm failed for ${name}:`, e.message)
            )
        )
    );
    // Initialize Database
    await initDatabase();
});
