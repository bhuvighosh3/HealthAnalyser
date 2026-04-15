# AthleteIQ

> AI-powered Strava health analyser — collects real training data, performs statistical EDA, hypothesises goal feasibility, delivers personalised training plans, and generates RAG-grounded nutrition guidance via a dedicated agent. Powered by Google ADK (Gemini 2.5 Flash + Vertex AI).

**Live:** https://athleteiq-290375529887.us-central1.run.app

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
**File:** `controllers/forecastController.js` — **EDA Agent** section, `computeTrainingMetrics()` function

A dedicated **EDA Agent** (`LlmAgent` via Google ADK) calls the `compute_training_metrics` `FunctionTool` which executes deterministic statistical computations over the collected Strava data:

| Metric | What it computes |
|---|---|
| `pace_trend` | Linear regression slope over all runs — direction (improving/stable/regressing), avg, fastest, slowest |
| `volume_trend` | Weekly distance aggregation, avg vs recent volume, peak week, 6-week breakdown |
| `consistency` | Weeks active in last 4, avg days between runs, longest gap, consistency % |
| `training_load` | Avg session duration, avg run distance, avg HR, avg suffer score |

The ADK agent calls the tool with `metric='all'`, receives the computed JSON, and writes a natural-language EDA report citing the specific numbers. This EDA summary is passed as grounded context to the Hypothesis Agent.

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
    CalMCP["Google Calendar MCP\n(ADK MCPToolset)"]
    CalAPI["Google Calendar API"]
    SQLite["SQLite DB\n(health_data.db)"]
    Firestore["Firestore Vector Store\n(nutrition_vectors)"]
    Firecrawl["Firecrawl Search API\n(nutrition RAG)"]
    VertexEmbed["Vertex AI\ntext-embedding-004"]

    Browser -->|REST /api/*| Server
    Server -->|Token refresh| StravaAPI
    Server -->|ADK LlmAgent + MCPToolset| StravaMCP
    StravaMCP -->|OAuth Bearer| StravaAPI
    Server -->|ADK LlmAgent + GOOGLE_SEARCH| GeminiAI
    Server -->|ADK FunctionTool| GeminiAI
    Server -->|ADK LlmAgent + MCPToolset| CalMCP
    CalMCP -->|OAuth2| CalAPI
    Server -->|read/write| SQLite
    Server -->|search + scrape| Firecrawl
    Firecrawl -->|markdown chunks| Server
    Server -->|embed chunks| VertexEmbed
    VertexEmbed -->|768-dim vectors| Firestore
    Firestore -->|findNearest COSINE| Server
```

---

## Multi-Agent Pipeline

```mermaid
flowchart TD
    COLLECT([Step 1: Collect\nStrava REST API\n50 activities + stats]) --> EDA

    EDA{EDA Agent\nADK LlmAgent\nGemini 2.5 Flash}
    EDA -->|ADK FunctionTool call| TOOL[Statistical Computation\npace_trend · volume_trend\nconsistency · training_load]
    TOOL -->|computed JSON| EDA
    EDA -->|EDA summary text| HYP

    HYP{Hypothesis Agent\nGemini 2.5 Flash}
    HYP -->|structured JSON handoff| REC

    REC{Recommendation Agent\nGemini 2.5 Flash}
    REC --> OUT[Training plan · Recovery advice\nMilestones · Weekly targets]

    NUT{Nutrition RAG Agent\nADK LlmAgent}
    Firestore[(Firestore\nVector Store)] -->|top-K semantic chunks| NUT
    FC[Firecrawl /search\nHopkins · WHO · Harvard] -->|first run only| Firestore
    OUT -->|user presses button| NUT
    NUT --> NUTOUT[Personalised nutrition plan\ngrounded in authoritative sources]

    OUT -->|user presses Schedule| PREVIEW[Human-in-the-loop\nPreview proposed events\ndate · time · intensity]
    PREVIEW -->|user confirms| CAL{Calendar Scheduling Agent\nADK LlmAgent + Calendar MCPToolset}
    CAL --> CALEVENTS[Events created in\nGoogle Calendar]
```

---

## Concept Checklist

### Required
| Concept | Status | Location |
|---|---|---|
| Frontend | ✅ | `public/index.html`, `public/app.js` |
| Agent framework | ✅ | **Google ADK** (`@google/adk`) — `LlmAgent`, `FunctionTool`, `MCPToolset`, `GOOGLE_SEARCH` |
| Tool calling | ✅ | `compute_training_metrics` FunctionTool (EDA), Strava MCPToolset, Calendar MCPToolset |
| Non-trivial dataset | ✅ | Strava activities API — real training history, fetched at runtime |
| Multi-agent pattern | ✅ | EDA → Hypothesis → Recommendation (3-agent handoff) + separate Nutrition RAG Agent |
| Deployed | ✅ | Google Cloud Run — https://athleteiq-290375529887.us-central1.run.app |
| README | ✅ | This file |

### Grab-Bag (≥2 required — we have 6)
| Concept | Status | Location |
|---|---|---|
| Structured output | ✅ | Hypothesis JSON + Recommendation JSON with strict schemas |
| Data visualization | ✅ | Chart.js — distance, pace, weekly volume, HR zones, efficiency |
| Second data retrieval | ✅ | Google Search grounding (fitness chat) + Firecrawl search (nutrition RAG) |
| Iterative refinement loop | ✅ | ADK `runAgent` event loop; EDA FunctionTool; Calendar MCPToolset multi-round |
| RAG | ✅ | Firecrawl → Vertex AI embeddings → Firestore vector store → `findNearest` semantic search → Nutrition Agent |
| Login / multi-account | ✅ | Login page with own-credentials mode and two sample profiles with real data |
| Human-in-the-loop | ✅ | Calendar scheduling preview — proposed events shown for user approval before agent writes to Google Calendar |

---

## Login Page

The app starts with a login screen (`/login.html`) offering two modes:

| Mode | Description |
|---|---|
| **My Account** | Enter your own Strava Client ID, Client Secret, Access Token, and Refresh Token. The server switches to your account live. |
| **Sample Profile 1** | Real Strava data — no setup needed. |
| **Sample Profile 2** | Real Strava data — no setup needed. |

Session is stored in `localStorage`. A **Logout** button in the header clears the session and returns to login.

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
    STRAVA[Live Strava data] --> AGENT
    AGENT --> PLAN([Personalised nutrition plan])
```

Chunks are crawled **once per 7 days per goal category** and stored in Firestore with Vertex AI vector embeddings. Subsequent requests skip the crawl entirely and go straight to semantic search.

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

    Note over Server: On every API call (both profiles)
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
# Sample Profile 1 (primary Strava account)
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_ACCESS_TOKEN=
STRAVA_REFRESH_TOKEN=
STRAVA_EXPIRES_AT=

# Sample Profile 2 (second Strava account)
RISHIT_CLIENT_ID=...
RISHIT_CLIENT_SECRET=...
RISHIT_ACCESS_TOKEN=
RISHIT_REFRESH_TOKEN=
RISHIT_EXPIRES_AT=

GCP_PROJECT_ID=your_gcp_project
GCP_LOCATION=us-central1
GOOGLE_OAUTH_CREDENTIALS=/absolute/path/to/gcp-oauth.keys.json  # optional (Calendar)
FIRECRAWL_API_KEY=fc-...                                          # for Nutrition RAG
```

### 3. Strava OAuth
```bash
npm start
# Sample Profile 1: http://localhost:3000/auth
# Sample Profile 2: http://localhost:3000/auth?profile=rishit
```

### 4. Google Calendar (optional)
Create `gcp-oauth.keys.json` with your OAuth 2.0 Desktop credentials, set `GOOGLE_OAUTH_CREDENTIALS` in `.env`, then:
```bash
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json npx @cocal/google-calendar-mcp auth
```

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
| Calendar | `@cocal/google-calendar-mcp` (ADK MCPToolset) |
| Nutrition RAG | Firecrawl `/search` → Vertex AI `text-embedding-004` → Firestore vector store → `findNearest` COSINE search |
| Vector DB | Google Firestore (`nutrition_vectors` collection, 768-dim vectors) |
| Database | SQLite (`sqlite3`) — activity cache |
| Deployment | Google Cloud Run (`healthmonitor-493021`, `us-central1`) |
