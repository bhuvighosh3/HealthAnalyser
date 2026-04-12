# AthleteIQ

> AI-powered Strava health analyser — collects real training data, performs statistical EDA, hypothesises goal feasibility, delivers personalised plans, and generates RAG-grounded nutrition guidance. Powered by Google ADK (Gemini 2.5 Flash + Vertex AI).

**Live:** https://athleteiq-290375529887.us-central1.run.app

---

## Collect → EDA → Hypothesize Pipeline

### Step 1: Collect
**File:** `controllers/forecastController.js` — top of `exports.forecast`

At runtime, the agent fetches from the Strava REST API:
- `/athlete/activities?per_page=50` — full activity history (distance, pace, HR, elevation, suffer score)
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

This is then handed off to the **Recommendation Agent** which generates the full training plan, nutrition tips, milestones, and weekly targets.

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
    Firecrawl["Firecrawl Search API\n(nutrition RAG)"]

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
    Firecrawl -->|topic-labelled context| Server
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
    REC --> OUT[Training plan · Nutrition tips\nMilestones · Calendar scheduling]

    NUT{Nutrition RAG Agent\nADK LlmAgent}
    Firecrawl[Firecrawl Search\nHopkins/WHO/Harvard] -->|topic-labelled sections| NUT
    OUT -->|user presses button| NUT
    NUT --> NUTOUT[Personalised nutrition plan\ngrounded in crawled sources]
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
| Multi-agent pattern | ✅ | EDA → Hypothesis → Recommendation (3-agent handoff) + Nutrition RAG Agent |
| Deployed | ✅ | Google Cloud Run — https://athleteiq-290375529887.us-central1.run.app |
| README | ✅ | This file |

### Grab-Bag (≥2 required — we have 5)
| Concept | Status | Location |
|---|---|---|
| Structured output | ✅ | Hypothesis JSON + Recommendation JSON with strict schemas |
| Data visualization | ✅ | Chart.js — distance, pace, weekly volume, HR zones, efficiency |
| Second data retrieval | ✅ | Google Search grounding (fitness chat) + Firecrawl search (nutrition RAG) |
| Iterative refinement loop | ✅ | ADK `runAgent` event loop; EDA FunctionTool; Calendar MCPToolset multi-round |
| RAG | ✅ | Firecrawl searches nutrition sources → topic-labelled context → ADK Nutrition Agent |

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

## Chat Intent Routing

```mermaid
flowchart LR
    MSG([User message]) --> ROUTER{Router Agent\nfew-shot classify}
    ROUTER -->|strava| MCP[ADK LlmAgent + MCPToolset\nLive Strava data + REST context]
    ROUTER -->|fitness| SEARCH[ADK LlmAgent + GOOGLE_SEARCH\nFitness knowledge]
    ROUTER -->|off-topic| REFUSE[Instant refusal\nno AI call]
    MCP --> REPLY([Reply to user])
    SEARCH --> REPLY
    REFUSE --> REPLY
```

---

## Nutrition RAG Pipeline

```mermaid
flowchart LR
    GOAL([User goal\ne.g. Run a marathon]) --> CLASSIFY{classifyGoal\nrunning/weight_loss\ncycling/general}
    CLASSIFY --> QUERIES[Goal-specific\nFirecrawl search queries]
    QUERIES --> FC[Firecrawl /search\nJohns Hopkins · WHO · Harvard]
    FC --> STRUCT[structureContent\nTopic-labelled sections\nPRE-WORKOUT · CARBS\nHYDRATION · RECOVERY...]
    STRUCT --> CACHE[(In-memory cache\n6h TTL)]
    CACHE --> AGENT[ADK LlmAgent\nNutrition Agent\nGemini 2.5 Flash]
    STRAVA[Live Strava data] --> AGENT
    AGENT --> PLAN([Personalised nutrition plan])
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
STRAVA_CLIENT_ID=...
STRAVA_CLIENT_SECRET=...
STRAVA_ACCESS_TOKEN=
STRAVA_REFRESH_TOKEN=
STRAVA_EXPIRES_AT=
GCP_PROJECT_ID=your_gcp_project
GCP_LOCATION=us-central1
GOOGLE_OAUTH_CREDENTIALS=/absolute/path/to/gcp-oauth.keys.json  # optional (Calendar)
FIRECRAWL_API_KEY=fc-...                                          # for Nutrition RAG
```

### 3. Strava OAuth
```bash
npm start
# Visit http://localhost:3000/auth
```

### 4. Google Calendar (optional)
Create `gcp-oauth.keys.json` with your OAuth 2.0 Desktop credentials, set `GOOGLE_OAUTH_CREDENTIALS` in `.env`, then:
```bash
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json npx @cocal/google-calendar-mcp auth
```

### 5. Run
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
| Nutrition RAG | Firecrawl `/search` → topic-labelled context → ADK LlmAgent |
| Database | SQLite (`sqlite3`) — activity cache |
| Deployment | Google Cloud Run (`healthmonitor-493021`, `us-central1`) |
