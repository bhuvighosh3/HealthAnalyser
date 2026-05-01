# AthleteIQ

> AI-powered Strava health analyser — collects real training data, performs deterministic statistical EDA, hypothesises goal feasibility, delivers personalised training plans, and generates RAG-grounded nutrition guidance via a dedicated agent. Powered by Google ADK (Gemini 2.5 Flash + Vertex AI).

**Live:** https://athleteiq-290375529887.us-central1.run.app

---

## Quickstart — No Setup Required

Don't want to configure your own Strava account? Just use one of the three built-in sample profiles on the login screen. Each is connected to a real Strava account with live training data:

| Profile | Description |
|---|---|
| **Bhuvi** | Real activity history — no setup needed |
| **Rishit** | Real activity history — no setup needed |
| **Ritwik** | Real activity history — no setup needed |

All three profiles are connected in real time — activities, stats, and AI analysis reflect their actual Strava data.

If you'd like to connect your **own** Strava account instead:

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create a free API app
   - **Authorization Callback Domain:** `athleteiq-290375529887.us-central1.run.app`
   - Note your **Client ID** and **Client Secret**
2. Open the app and click **My Account** on the login screen
3. Enter your Client ID and Client Secret, then click **Continue to Strava**
4. Authorize the app on Strava's website
5. You'll be returned to the app automatically — you're connected

---

## Collect → EDA → Hypothesize Pipeline

### Step 1: Collect
**File:** `controllers/forecastController.js` — top of `exports.forecast`

At runtime, the agent fetches from the Strava REST API:
- `/athlete/activities?per_page=200` — full activity history (distance, pace, HR, elevation, suffer score)
- `/athlete` — athlete profile
- `/athletes/:id/stats` — all-time and YTD aggregates

Data is real, live, and non-trivial (full athlete training history). It is also enriched server-side with MET-based calorie estimates per activity type.

### Step 2: Explore and Analyse (EDA)
**File:** `controllers/forecastController.js` — `computeTrainingMetrics()` function

`computeTrainingMetrics('all', activities)` runs deterministic statistical computations directly over the collected Strava data — no LLM agent in this step. The results are formatted into a structured markdown summary and passed as grounded context to the Hypothesis Agent.

| Metric | What it computes |
|---|---|
| `pace_trend` | Linear regression slope over all runs — direction (improving/stable/regressing), avg, fastest, slowest |
| `volume_trend` | Weekly distance aggregation, avg vs recent volume, peak week, 6-week breakdown |
| `consistency` | Weeks active in last 4, avg days between runs, longest gap, consistency % |
| `training_load` | Avg session duration, avg run distance, avg HR, avg suffer score |

### Step 3: Hypothesize
**File:** `controllers/forecastController.js` — **Hypothesis Check Agent** section

The Hypothesis Agent receives the EDA findings + raw activities + user profile and produces a structured JSON hypothesis:
- `feasibility`: achievable / challenging / unrealistic
- `feasibilityScore`: 0–100
- `projections`: weeks to goal, expected progress by deadline, total kcal burned
- `assumptions`, `gaps`, `riskFactors`
- `summary`: 2–3 sentences grounded in the EDA data

This is then handed off to the **Recommendation Agent** which generates a personalised training plan, recovery advice, milestones, and weekly targets.

> **Note:** Nutrition advice is intentionally excluded from the Recommendation Agent — it is handled by the dedicated **AI Nutrition Agent** (see below).

---

## Architecture

```mermaid
graph TD
    Browser["Browser (AthleteIQ UI)"]
    Server["Express Server (Node.js)"]
    StravaAPI["Strava REST API"]
    StravaMCP["Strava MCP Server\n(ADK MCPToolset)"]
    GeminiAI["Gemini 2.5 Flash\n(Vertex AI)"]
    CalAPI["Google Calendar API\n(googleapis)"]
    FSCal["Firestore\ngcal_sessions"]
    SQLite["SQLite DB\n(health_data.db)"]
    FSNut["Firestore\nnutrition_vectors"]
    Firecrawl["Firecrawl Search API\n(nutrition RAG)"]
    VertexEmbed["Vertex AI\ntext-embedding-004"]

    Browser -->|REST /api/*| Server
    Server -->|Token refresh| StravaAPI
    Server -->|ADK LlmAgent + MCPToolset| StravaMCP
    StravaMCP -->|OAuth Bearer| StravaAPI
    Server -->|ADK LlmAgent + GOOGLE_SEARCH| GeminiAI
    Server -->|ADK FunctionTool| GeminiAI
    Server -->|per-user OAuth tokens| FSCal
    FSCal -->|read/write events| CalAPI
    Server -->|read/write| SQLite
    Server -->|search + scrape| Firecrawl
    Firecrawl -->|markdown chunks| Server
    Server -->|embed chunks| VertexEmbed
    VertexEmbed -->|768-dim vectors| FSNut
    FSNut -->|findNearest COSINE| Server
```

---

## Multi-Agent Pipeline

```mermaid
flowchart TD
    COLLECT([Step 1: Collect\nStrava REST API\n50 activities + stats]) --> EDA

    EDA[EDA: computeTrainingMetrics\nDeterministic\npace_trend · volume_trend\nconsistency · training_load]
    EDA -->|formatted EDA summary| HYP

    HYP{Hypothesis Agent\nGemini 2.5 Flash}
    HYP -->|structured JSON handoff| REC

    REC{Recommendation Agent\nGemini 2.5 Flash}
    REC --> OUT[Training plan · Recovery advice\nMilestones · Weekly targets]

    NUT{Nutrition RAG Agent\nADK LlmAgent}
    Firestore[(Firestore\nVector Store)] -->|top-K semantic chunks| NUT
    FC[Firecrawl /search\nHopkins · WHO · Harvard] -->|first run only| Firestore
    OUT -->|user presses button| NUT
    NUT --> NUTOUT[Personalised nutrition plan\ngrounded in authoritative sources]

    OUT -->|user picks start date\n+ connects Google Calendar| CAL{Calendar Scheduling\nGoogle Calendar API\nreads free slots · writes events}
    CAL --> CALEVENTS[Workouts scheduled in\nuser's own Google Calendar]
```

---

## Concept Checklist

### Required
| Concept | Status | Location |
|---|---|---|
| Frontend | ✅ | `public/index.html`, `public/app.js` |
| Agent framework | ✅ | **Google ADK** (`@google/adk`) — `LlmAgent`, `FunctionTool`, `MCPToolset`, `GOOGLE_SEARCH` |
| Tool calling | ✅ | Strava MCPToolset (chat), Google Calendar API (scheduling) |
| Non-trivial dataset | ✅ | Strava activities API — real training history, fetched at runtime |
| Multi-agent pattern | ✅ | EDA (deterministic) → Hypothesis → Recommendation (pipeline handoff) + separate Nutrition RAG Agent |
| Deployed | ✅ | Google Cloud Run — https://athleteiq-290375529887.us-central1.run.app |
| README | ✅ | This file |

### Grab-Bag (≥2 required — we have 6)
| Concept | Status | Location |
|---|---|---|
| Structured output | ✅ | Hypothesis JSON + Recommendation JSON with strict schemas |
| Data visualization | ✅ | Chart.js — distance, pace, weekly volume, HR zones, efficiency |
| Second data retrieval | ✅ | Google Search grounding (fitness chat) + Firecrawl search (nutrition RAG) |
| Iterative refinement loop | ✅ | ADK `runAgent` event loop (chat/nutrition); Calendar MCPToolset multi-round |
| RAG | ✅ | Firecrawl → Vertex AI embeddings → Firestore vector store → `findNearest` semantic search → Nutrition Agent |
| Login / multi-account | ✅ | Login page with own-credentials mode and three sample profiles (Bhuvi, Rishit, Ritwik) with real data |
| Human-in-the-loop | ✅ | Google Calendar scheduling — reads free slots, creates events in user's own calendar via per-user OAuth |

---

## Login Page

The app starts with a login screen (`/login.html`) offering two modes:

| Mode | Description |
|---|---|
| **My Account** | Enter your own Strava Client ID, Client Secret, Access Token, and Refresh Token. The server switches to your account live. |
| **Sample Profile 1 — Bhuvi** | Real Strava data — no setup needed. |
| **Sample Profile 2 — Rishit** | Real Strava data — no setup needed. |
| **Sample Profile 3 — Ritwik** | Real Strava data — no setup needed. |

Session is stored in `sessionStorage` (clears on browser/tab close — login required on every fresh session). A **Logout** button in the header clears the session and returns to login.

---

## Nutrition RAG Pipeline

```mermaid
flowchart LR
    GOAL([User goal\ne.g. Run a marathon]) --> CLASSIFY{classifyGoal\nrunning / weight_loss\ncycling / general}
    CLASSIFY --> CHECK{Firestore\nhasValidChunks\nTTL = 7 days}
    CHECK -->|fresh| SEARCH[semanticSearch\nfindNearest COSINE\ntop-8 chunks]
    CHECK -->|stale / empty| FC[Firecrawl /search\nJohns Hopkins · WHO · Harvard]
    FC --> EMBED[Vertex AI\ntext-embedding-004\n768-dim vectors]
    EMBED --> FS[(Firestore\nnutrition_vectors)]
    FS --> SEARCH
    SEARCH --> AGENT[ADK LlmAgent\nNutrition Agent\nGemini 2.5 Flash]
    STRAVA[Last 7 Strava activities] --> AGENT
    PREFS[Allergies & dislikes\ntyped by user] --> AGENT
    AGENT --> PLAN([Personalised nutrition plan\nhonours dietary restrictions])
```

Chunks are crawled **once per 7 days per goal category** and stored in Firestore with Vertex AI vector embeddings. Subsequent requests skip the crawl entirely and go straight to semantic search.

### Dietary Preferences

Before generating the plan the user can optionally enter:
- **Allergies** — foods the agent must never suggest (e.g. `peanuts, shellfish, lactose`)
- **Dislikes** — foods to avoid entirely, not even as alternatives (e.g. `tofu, beets`)

These are collected **after** the RAG retrieval runs (so they do not affect which chunks are retrieved) and injected into the agent instruction alongside the RAG context. The agent receives an explicit hard constraint: *never suggest allergenic foods; omit disliked foods entirely*.

---

## Google Calendar Scheduling

- Each user connects their **own** Google account — events go to their calendar, not the app owner's
- Sessions stored in Firestore (`gcal_sessions`) — survive page refreshes and server restarts
- Only schedules at reasonable hours: 6:30am, 5:30pm, 7:00am, 6:00pm — no odd night times
- Reads existing events first to avoid double-booking

> **Connecting your Google account:** When you click **Connect Google Calendar**, Google may show an "App isn't verified" warning screen. Click **Advanced** at the bottom of that screen, then click **Go to AthleteIQ (unsafe)** to proceed. This is expected for apps that haven't gone through Google's verification process — your data is only used to schedule workouts into your own calendar.

---

## Chat Intent Routing

```mermaid
flowchart LR
    MSG([User message]) --> ROUTER{Router\nfew-shot classify}
    ROUTER -->|greeting| GREET[Friendly welcome reply]
    ROUTER -->|strava| MCP[ADK LlmAgent + MCPToolset\nPre-fetched REST context\n+ 200 activities + YTD stats]
    ROUTER -->|fitness| SEARCH[ADK LlmAgent + GOOGLE_SEARCH\nFitness knowledge]
    ROUTER -->|off-topic| REFUSE[Instant refusal]
    MCP --> REPLY([Rendered reply])
    SEARCH --> REPLY
    GREET --> REPLY
    REFUSE --> REPLY
```

Chat replies render markdown (bold, bullets, headings) as formatted HTML in the chat bubble.

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

    Note over Server: On every API call (all three profiles)
    Server->>Server: ensureValidToken() / ensureValidProfileToken()
    alt token expires within 1 hour
        Server->>Strava: POST /oauth/token (refresh)
        Strava-->>Server: new access_token
        Server->>Server: resetMcpClient() — respawn with fresh token
    end
```

---

## Setup

### 1. Clone & install
```bash
git clone https://github.com/bhuvighosh3/HealthAnalyser.git
cd HealthAnalyser
npm install   # postinstall automatically patches strava-mcp-server weight field
```

### 2. Environment variables — `.env`
```env
# Sample Profile 1 — Bhuvi's Strava account
BHUVI_CLIENT_ID=...
BHUVI_CLIENT_SECRET=...
BHUVI_ACCESS_TOKEN=
BHUVI_REFRESH_TOKEN=
BHUVI_EXPIRES_AT=

# Sample Profile 2 — Rishit's Strava account
RISHIT_CLIENT_ID=...
RISHIT_CLIENT_SECRET=...
RISHIT_ACCESS_TOKEN=
RISHIT_REFRESH_TOKEN=
RISHIT_EXPIRES_AT=

# Sample Profile 3 — Ritwik's Strava account
RITWIK_CLIENT_ID=...
RITWIK_CLIENT_SECRET=...
RITWIK_ACCESS_TOKEN=
RITWIK_REFRESH_TOKEN=
RITWIK_EXPIRES_AT=

GCP_PROJECT_ID=your_gcp_project
GCP_LOCATION=us-central1
FIRECRAWL_API_KEY=fc-...                                          # for Nutrition RAG
APP_URL=https://<your-cloud-run-url>                              # fixes redirect URI on Cloud Run

# Google Calendar (per-user OAuth — Web Application client)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://<your-cloud-run-url>/auth/google-calendar/callback
```

### 3. Strava OAuth

#### Getting Your Strava API Credentials (one-time setup)

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Click **Create an App** (or view your existing app)
3. Fill in the form:
   - **Application Name:** Anything you like (e.g. `My AthleteIQ`)
   - **Category:** Choose any
   - **Website:** Can be anything
   - **Authorization Callback Domain:** `athleteiq-290375529887.us-central1.run.app`
4. Note your **Client ID** and **Client Secret** — you'll need these below

#### Connecting Your Strava Account

```bash
npm start
# Sample Profile 1 (Bhuvi):  http://localhost:3000/auth
# Sample Profile 2 (Rishit): http://localhost:3000/auth?profile=rishit
# Sample Profile 3 (Ritwik): http://localhost:3000/auth?profile=ritwik
```

If you're connecting your own account via the **My Account** login mode:

1. Open the app in your browser — you'll see the login screen
2. Click **My Account** and enter your Strava **Client ID** and **Client Secret**
3. Click **Continue to Strava** — you'll be redirected to Strava's authorization page
4. Authorize the app on Strava's website
5. You'll be returned to the app automatically — you're connected

Your tokens are refreshed automatically on every server start (no re-auth needed after the first time).

### 4. Google Calendar (per-user OAuth)
Create a **Web Application** OAuth 2.0 client in [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).

Add these redirect URIs:
```
http://localhost:3000/auth/google-calendar/callback
https://<your-cloud-run-url>/auth/google-calendar/callback
```

Add to `.env`:
```env
GOOGLE_CLIENT_ID=<web client id>
GOOGLE_CLIENT_SECRET=<web client secret>
GOOGLE_REDIRECT_URI=https://<your-cloud-run-url>/auth/google-calendar/callback
```

Publish the OAuth app (APIs & Services → OAuth consent screen → Audience → Publishing status → In production) so any Google account can connect.

Each user clicks **Connect Google Calendar** in the app → authenticates with their own Google account → workouts are scheduled into **their** calendar. Sessions are stored in Firestore (`gcal_sessions` collection) and survive page refreshes and server restarts.

### 5. GCP Firestore (vector store for Nutrition RAG)
```bash
gcloud services enable firestore.googleapis.com --project <PROJECT>
gcloud firestore databases create --location=us-central1 --project <PROJECT>
# Vector index (run once — takes ~5 min)
gcloud firestore indexes composite create \
  --collection-group=nutrition_vectors \
  --query-scope=COLLECTION \
  --field-config=field-path=goalCategory,order=ASCENDING \
  --field-config=field-path=embedding,vector-config='{"dimension":768,"flat":{}}' \
  --project=<PROJECT>
```

### 6. Run
```bash
npm start  # http://localhost:3000
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, Chart.js 4, Lucide icons |
| Backend | Node.js, Express 5 |
| AI / Agents | **Google ADK** (`@google/adk` v0.6.1) — `LlmAgent`, `FunctionTool`, `MCPToolset`, `GOOGLE_SEARCH` |
| Model | Gemini 2.5 Flash via Vertex AI |
| Strava data | Strava REST API + `@r-huijts/strava-mcp-server` (ADK MCPToolset) |
| Calendar | `googleapis` — direct Google Calendar API v3 with per-user OAuth2 (sessions in Firestore) |
| Nutrition RAG | Firecrawl `/search` → Vertex AI `text-embedding-004` → Firestore vector store → `findNearest` COSINE search |
| Vector DB | Google Firestore (`nutrition_vectors` collection, 768-dim vectors) |
| Database | SQLite (`sqlite3`) — activity cache |
| Deployment | Google Cloud Run (`healthmonitor-493021`, `us-central1`) |
