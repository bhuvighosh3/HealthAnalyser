# AthleteIQ

> AI-powered Strava health analyser with goal forecasting, personalised training plans, and Google Calendar scheduling — powered by Gemini 2.5 Flash.

---

## Features

- **Live Strava data** via Strava MCP — activities, stats, athlete profile
- **Smart Charts** — distance trend, pace trend, weekly volume, heart rate distribution, activity types, efficiency
- **Goal Forecast** — hypothesis check agent validates your goal against real data, then a recommendation agent builds a personalised plan with handoff
- **AI Chat** — intent-routed assistant: Strava questions use live MCP tool calls, fitness questions use Google Search, off-topic is refused
- **Google Calendar scheduling** — AI agent finds free slots and schedules workouts automatically

---

## Architecture

```mermaid
graph TD
    Browser["Browser (AthleteIQ UI)"]
    Server["Express Server (Node.js)"]
    StravaAPI["Strava REST API"]
    StravaMCP["Strava MCP Server\n(subprocess)"]
    GeminiAI["Gemini 2.5 Flash\n(Vertex AI)"]
    CalMCP["Google Calendar MCP Server\n(subprocess)"]
    CalAPI["Google Calendar API"]
    SQLite["SQLite DB\n(health_data.db)"]

    Browser -->|REST /api/*| Server
    Server -->|Token refresh| StravaAPI
    Server -->|MCP tool calls| StravaMCP
    StravaMCP -->|OAuth Bearer| StravaAPI
    Server -->|generateContent| GeminiAI
    GeminiAI -->|function calls| StravaMCP
    GeminiAI -->|function calls| CalMCP
    CalMCP -->|OAuth2| CalAPI
    Server -->|read/write| SQLite
```

---

## OAuth & Token Flow

```mermaid
sequenceDiagram
    participant User
    participant Server
    participant Strava

    User->>Server: GET /auth
    Server->>Strava: Redirect to OAuth consent
    Strava-->>Server: GET /exchange_token?code=...
    Server->>Strava: POST /oauth/token (exchange code)
    Strava-->>Server: access_token + refresh_token + expires_at
    Server->>Server: Persist tokens to .env

    Note over Server: On every API call
    Server->>Server: ensureValidToken()
    alt token expires within 1 hour
        Server->>Strava: POST /oauth/token (refresh)
        Strava-->>Server: new access_token
        Server->>Server: resetMcpClient() — respawn with fresh token
    end
```

---

## AI Agent Flow

```mermaid
flowchart TD
    A([User clicks Analyse My Goal]) --> B[Fetch /api/stats + /api/forecast in parallel]

    B --> C[Render Smart Charts]
    B --> D{Hypothesis Check Agent\nGemini 2.5 Flash}

    D -->|Structured JSON| E{Handoff to\nRecommendation Agent}
    E -->|weeklyTrainingPlan\nnutritionTips\nrecovery\nmilestones| F[Render Forecast Results]

    F --> G[Show Schedule in Calendar button]
    G --> H{Calendar Scheduling Agent\nGemini + Google Calendar MCP}
    H -->|list events| I[Check free slots]
    I -->|create event| J[Schedule workout]
    J -->|next workout| I
    J --> K[Summary shown to user]
```

---

## Chat Intent Routing

```mermaid
flowchart LR
    MSG([User message]) --> ROUTER{Router Agent\nfew-shot classify}

    ROUTER -->|strava| MCP[MCP Tool Loop\nLive Strava data]
    ROUTER -->|fitness| SEARCH[Google Search\nFitness knowledge]
    ROUTER -->|off-topic| REFUSE[Instant refusal\nno AI call]

    MCP --> REPLY([Reply to user])
    SEARCH --> REPLY
    REFUSE --> REPLY
```

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/bhuvighosh3/HealthAnalyser.git
cd HealthAnalyser
npm install
```

### 2. Environment variables

Create a `.env` file:

```env
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret
STRAVA_ACCESS_TOKEN=
STRAVA_REFRESH_TOKEN=
STRAVA_EXPIRES_AT=
GCP_PROJECT_ID=your_gcp_project_id
GCP_LOCATION=us-central1
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json   # optional — for Calendar
```

### 3. Strava OAuth

```bash
npm start
# Visit http://localhost:3000/auth
```

### 4. Google Calendar (optional)

1. Create an OAuth 2.0 Desktop client in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Google Calendar API
3. Create `gcp-oauth.keys.json`:

```json
{
  "installed": {
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob", "http://localhost"],
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token"
  }
}
```

4. Set `GOOGLE_OAUTH_CREDENTIALS=/absolute/path/to/gcp-oauth.keys.json` in `.env`
5. Run first-time auth:

```bash
npx @cocal/google-calendar-mcp auth
```

### 5. Run

```bash
npm start
# http://localhost:3000
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, Chart.js 4, Lucide icons |
| Backend | Node.js, Express |
| AI | Google Gemini 2.5 Flash via Vertex AI (`@google/genai`) |
| Strava data | Strava REST API + `strava-mcp-server` |
| Calendar | `@cocal/google-calendar-mcp` |
| MCP bridge | `@modelcontextprotocol/sdk` + `mcpToTool()` |
| Database | SQLite (`better-sqlite3`) |

---

## Project Structure

```
├── controllers/
│   ├── aiController.js        # Chat with intent routing
│   ├── forecastController.js  # Hypothesis + Recommendation agents
│   ├── scheduleController.js  # Google Calendar scheduling agent
│   └── stravaController.js    # Strava data endpoints
├── services/
│   ├── aiService.js           # Gemini client singleton
│   ├── calendarMcpService.js  # Google Calendar MCP client
│   ├── mcpService.js          # Strava MCP client
│   └── stravaService.js       # Token refresh + Strava REST
├── routes/
│   └── apiRoutes.js
├── db/
│   └── database.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── server.js
```
