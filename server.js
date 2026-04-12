require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./db/database');
const { authorize, exchangeToken } = require('./controllers/stravaController');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Main Auth Routes (Non-API)
app.get('/auth', authorize);
app.get('/exchange_token', exchangeToken); // Make sure the OAuth redirect matches this or is /auth/exchange_token. Wait, stravaController uses `/auth/exchange_token`. Let me use `/exchange_token` to be backwards compatible.

// API Routes
app.use('/api', apiRoutes);

app.listen(PORT, async () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    // Initialize Database
    await initDatabase();
});
