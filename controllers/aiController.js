const path = require('path');
const { generateText } = require('../services/aiService');
const { fetchFromStrava, tokens, ensureValidToken } = require('../services/stravaService');
const { runAgent, createStdioMcpToolset, LlmAgent, GOOGLE_SEARCH, MODEL } = require('../services/adkService');

// ─── Router classifier prompt ────────────────────────────────────────────────

const ROUTER_SYSTEM = `Classify the user message into exactly one category.

Categories:
  strava   – questions about the athlete's OWN data (activities, pace, distance, heart rate,
             elevation, PRs, segments, recent runs, stats, training history, kudos, zones)
  fitness  – general fitness/health knowledge (training plans, nutrition, injury prevention,
             race prep, exercise science, recovery, gear recommendations, running technique)
  off-topic – everything else, including harmful, adversarial, or irrelevant requests

Examples:
User: "How many km did I run this week?"              → strava
User: "What's my average pace for last month?"        → strava
User: "Show me my recent activities"                  → strava
User: "How is my fitness progress?"                   → strava
User: "What are my heart rate zones?"                 → strava
User: "What was my fastest 5K?"                       → strava
User: "How many calories did I burn?"                 → strava
User: "How do I improve my VO2 max?"                  → fitness
User: "What should I eat before a marathon?"          → fitness
User: "Is it safe to run with shin splints?"          → fitness
User: "Best shoes for trail running in 2024?"         → fitness
User: "How many weeks of training for a half marathon?"→ fitness
User: "Write me a poem"                               → off-topic
User: "What's the weather today?"                     → off-topic
User: "Can you write code for me?"                    → off-topic
User: "Help me cheat in a race"                       → off-topic
User: "Hack someone's Strava account"                 → off-topic

Reply with ONLY the single category word: strava, fitness, or off-topic`;

// ─── Strava base system prompt + few-shot answer examples ────────────────────

const STRAVA_SYSTEM = `You are an expert Strava running coach embedded in a personal health dashboard.
All athlete data has already been fetched and is provided below under "LIVE STRAVA DATA".
You MUST answer directly from that data — never say you don't have access to it.

DOMAIN: Personal Strava data and training insights only.

═══════════════════════════════════════════════
FEW-SHOT ANSWER EXAMPLES
(showing how to use the LIVE STRAVA DATA block)
═══════════════════════════════════════════════

--- Example 1: Weekly mileage ---
User: "How many km did I run this week?"
[LIVE DATA shows: this week's km = 23.4 km across 3 runs]
You: "You've run **23.4 km** this week across 3 sessions — solid work! Your runs were on Mon (8.1 km), Wed (7.3 km) and Sat (8.0 km). That puts you slightly above your 4-week average of 21.1 km/week."

--- Example 2: Progress overview ---
User: "How is my fitness progress?"
[LIVE DATA shows: pace trend improving, consistency 75%, recent suffer scores 45–62]
You: "Your fitness is trending upward! 📈 Here's what the data shows:
• **Pace**: Improving — you're running ~8 sec/km faster than 4 weeks ago (avg now 5:12 min/km)
• **Consistency**: 75% — you ran in 3 of the last 4 weeks
• **Effort**: Avg suffer score of 52, which is moderate-high — good training stimulus
One gap: your long run hasn't exceeded 12 km recently. Adding one 15–18 km run per week would accelerate your aerobic base."

--- Example 3: Heart rate / effort ---
User: "What's my average heart rate when I run?"
[LIVE DATA shows: avg HR across last 10 runs = 152 bpm, range 138–171]
You: "Your average running heart rate over the last 10 activities is **152 bpm**, ranging from 138 bpm on easy days to 171 bpm on harder efforts. Based on a standard max HR estimate for your age, you're spending most of your time in Zone 3–4, which builds solid aerobic fitness."

--- Example 4: PR / best performance ---
User: "What was my fastest run?"
[LIVE DATA shows: fastest pace = 4:02 min/km on "Morning Run" 2024-11-14, distance 5.2 km]
You: "Your fastest recorded run was **4:02 min/km** on your 'Morning Run' on 14 Nov 2024 — a 5.2 km effort. That's a great pace! Your recent average is 5:18 min/km, so that run was about 76 sec/km faster than your current baseline."

--- Example 5: Recent activity summary ---
User: "What did I do yesterday?" or "Show me my recent runs"
[LIVE DATA shows last activity: 2025-03-10 | Run | "Easy Morning" | 7.2 km | 42 min | 148 bpm]
You: "Your most recent activity was an **Easy Morning run** on 10 Mar — 7.2 km in 42 minutes (5:50 min/km pace) with an average heart rate of 148 bpm. That's a nice aerobic effort — well within Zone 2!"

--- Off-domain refusals ---
User: "What stocks should I buy?"
You: "I'm your personal fitness assistant — I can only help with your Strava data and training. Try asking about your recent runs!"

User: "Write me some code"
You: "That's outside my area. Ask me about your pace, mileage, or activity history!"

═══════════════════════════════════════════════
ANSWER RULES
═══════════════════════════════════════════════
1. Always cite specific numbers, dates and activity names from the LIVE DATA block below.
2. Convert metres → km, seconds → "Xh Ym" or "X min/km" pace format.
3. Use the pre-computed weekly/monthly stats provided — do NOT say you cannot calculate them.
4. Be coach-like and encouraging; highlight one actionable insight per answer.
5. If asked about something not in the data (e.g. sleep, power), say so clearly rather than guessing.`;

// ─── Fitness system prompt ────────────────────────────────────────────────────

const FITNESS_SYSTEM = `You are a knowledgeable running and fitness coach with access to current web information.
Answer general fitness questions: training theory, nutrition, injury prevention, race strategies, exercise science, recovery, and gear.

DOMAIN: Fitness, running, cycling, triathlon, health, and wellbeing ONLY.

Refusal examples:
User: "What's the best programming language?" → "I focus exclusively on fitness topics."
User: "Tell me a joke" → "I'm a fitness coach! Ask me about training plans or recovery tips."
User: "Help me cheat in a race" → "I only support fair, safe athletic performance."

When answering: use web search for current info, give specific actionable advice, cite sources where helpful.`;

const OFF_TOPIC_REPLIES = [
    "I'm your Strava fitness assistant — I can only help with your training data and fitness questions. Try asking about your recent runs or a training tip!",
    "That's outside my domain. I specialise in your Strava data and general fitness advice. What would you like to know about your training?",
    "I focus on fitness and your Strava activities only. Feel free to ask me about your pace, mileage, heart rate zones, or training plans!",
];

// ─── Build rich Strava context block ─────────────────────────────────────────

async function buildStravaContext(athlete, activities, athleteStats) {
    const now   = Date.now();
    const msDay = 86400000;

    // Week / month buckets
    const weekStart  = now - 7  * msDay;
    const monthStart = now - 28 * msDay;

    const runs     = activities.filter(a => ['Run','VirtualRun','TrailRun','Treadmill'].includes(a.type));
    const allActs  = activities;

    const thisWeek  = allActs.filter(a => new Date(a.start_date) >= weekStart);
    const thisMonth = allActs.filter(a => new Date(a.start_date) >= monthStart);

    const weekKm  = thisWeek.reduce((s, a) => s + a.distance, 0) / 1000;
    const monthKm = thisMonth.reduce((s, a) => s + a.distance, 0) / 1000;

    // Pace stats (runs only, min/km)
    const paces = runs
        .filter(a => a.distance > 1000 && a.moving_time > 0)
        .map(a => (a.moving_time / 60) / (a.distance / 1000));

    const avgPace  = paces.length ? paces.reduce((s, p) => s + p, 0) / paces.length : null;
    const bestPace = paces.length ? Math.min(...paces) : null;

    const fmt = (minPerKm) => {
        if (!minPerKm) return 'N/A';
        const m = Math.floor(minPerKm);
        const s = Math.round((minPerKm - m) * 60);
        return `${m}:${String(s).padStart(2, '0')} min/km`;
    };

    // Heart rate stats
    const hrData = allActs.filter(a => a.average_heartrate).map(a => a.average_heartrate);
    const avgHR  = hrData.length ? Math.round(hrData.reduce((s, v) => s + v, 0) / hrData.length) : null;
    const maxHR  = hrData.length ? Math.round(Math.max(...hrData)) : null;

    // Longest & fastest run
    const sortedByDist = [...runs].sort((a, b) => b.distance - a.distance);
    const sortedByPace = [...runs].filter(a => a.distance > 2000).sort((a, b) =>
        (a.moving_time / a.distance) - (b.moving_time / b.distance)
    );

    // Suffer scores
    const sufferScores = allActs.filter(a => a.suffer_score).map(a => a.suffer_score);
    const avgSuffer    = sufferScores.length ? Math.round(sufferScores.reduce((s,v) => s+v, 0) / sufferScores.length) : null;

    // Consistency: active weeks in last 4
    const weekKeys = new Set(thisMonth.map(a => {
        const d = new Date(a.start_date);
        const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
        return ws.toISOString().slice(0, 10);
    }));

    // YTD from Strava stats
    const ytdRuns  = athleteStats?.ytd_run_totals;
    const allRuns  = athleteStats?.all_run_totals;

    const today = new Date().toDateString();

    return `
TODAY: ${today}
ATHLETE: ${athlete.firstname} ${athlete.lastname} | ${athlete.city || 'Unknown city'}, ${athlete.country || ''} | Sex: ${athlete.sex || 'N/A'}

══ COMPUTED STATS (use these to answer directly) ══
• This week  : ${weekKm.toFixed(1)} km across ${thisWeek.length} activit${thisWeek.length === 1 ? 'y' : 'ies'}
• Last 28 days: ${monthKm.toFixed(1)} km across ${thisMonth.length} activit${thisMonth.length === 1 ? 'y' : 'ies'}
• Avg pace (last ${runs.length} runs): ${fmt(avgPace)}
• Best pace recorded: ${fmt(bestPace)}${sortedByPace[0] ? ` — "${sortedByPace[0].name}" on ${new Date(sortedByPace[0].start_date).toDateString()}` : ''}
• Longest run: ${sortedByDist[0] ? `${(sortedByDist[0].distance/1000).toFixed(1)} km — "${sortedByDist[0].name}" on ${new Date(sortedByDist[0].start_date).toDateString()}` : 'N/A'}
• Avg heart rate: ${avgHR ? `${avgHR} bpm` : 'N/A'} | Peak HR recorded: ${maxHR ? `${maxHR} bpm` : 'N/A'}
• Avg suffer score: ${avgSuffer ?? 'N/A'}
• Consistency: ${weekKeys.size}/4 weeks active in last 28 days (${Math.round(weekKeys.size / 4 * 100)}%)
${ytdRuns ? `• YTD runs: ${ytdRuns.count} runs | ${(ytdRuns.distance/1000).toFixed(0)} km | ${Math.round(ytdRuns.moving_time/3600)} hrs` : ''}
${allRuns  ? `• All-time: ${allRuns.count} runs | ${(allRuns.distance/1000).toFixed(0)} km` : ''}

══ RECENT 30 ACTIVITIES (newest first) ══
${allActs.slice(0, 30).map((a, i) => {
    const pace = a.distance > 500 && a.moving_time > 0
        ? fmt((a.moving_time / 60) / (a.distance / 1000))
        : null;
    return `${i+1}. ${new Date(a.start_date).toDateString()} | ${a.type} | "${a.name}" | ${(a.distance/1000).toFixed(2)} km | ${Math.round(a.moving_time/60)} min${pace ? ` | ${pace}` : ''}${a.total_elevation_gain ? ` | ${Math.round(a.total_elevation_gain)}m elev` : ''}${a.average_heartrate ? ` | ${Math.round(a.average_heartrate)} bpm` : ''}${a.suffer_score ? ` | suffer ${a.suffer_score}` : ''}`;
}).join('\n')}
`.trim();
}

// ─── Analyse endpoint ─────────────────────────────────────────────────────────

exports.analyse = async (req, res) => {
    try {
        const { goal = 'General Fitness', focus = 'Multiple', context = 'None' } = req.body || {};

        const activities = await fetchFromStrava('/athlete/activities?per_page=30');
        if (!activities.length) return res.json({ error: 'No activities found to analyse.' });

        const prompt = `You are a professional athletic performance coach and data scientist.
Given the following 30 most recent Strava activities (in JSON):
${JSON.stringify(activities)}

User's Preferences:
- Primary Goal: ${goal}
- Main Focus Area: ${focus}
- Additional Personal Context: ${context}

Analyze this data and return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "metrics": {
    "consistencyScore": 0-100,
    "avgSufferScore": number
  },
  "insights": [
    {
      "title": "...",
      "icon": "trending-up | gauge | flame | lightbulb | activity",
      "text": "..."
    }
  ]
}

- Consistency Score: Inferred based on frequency and gaps (100 is highly regular).
- Avg Suffer Score: Average effort score for recent activities.
- Use the actual data from the activities. Be specific and reference actual numbers in the insights.
- Ensure "insights" has at least 4 items that address the user's focus: "${focus}".`;

        let text = await generateText(prompt);
        text = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        // eslint-disable-next-line no-control-regex
        text = text.replace(/[\x00-\x1F\x7F-\x9F]/g, " ");

        res.json(JSON.parse(text));
    } catch (error) {
        console.error('--- ANALYSIS ERROR ---', error.message);
        res.status(500).json({ error: 'Failed to generate analysis: ' + error.message });
    }
};

// ─── Chat endpoint (ADK-powered) ──────────────────────────────────────────────

exports.chat = async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage) return res.status(400).json({ error: "Missing message" });

    try {
        // Step 1: Classify intent
        const category = (await generateText(
            [{ role: 'user', parts: [{ text: ROUTER_SYSTEM + '\n\nUser: "' + userMessage + '"' }] }]
        )).trim().toLowerCase().replace(/[^a-z-]/g, '');

        console.log(`[Chat] intent="${category}" message="${userMessage.slice(0, 80)}"`);

        // Step 2: Off-topic → instant refusal
        if (category === 'off-topic' || !['strava', 'fitness'].includes(category)) {
            const reply = OFF_TOPIC_REPLIES[Math.floor(Math.random() * OFF_TOPIC_REPLIES.length)];
            return res.json({ reply });
        }

        // Step 3a: Strava ─────────────────────────────────────────────────────
        if (category === 'strava') {
            // Fetch all data in parallel: athlete profile + full activity list + YTD stats
            await ensureValidToken();
            const [athlete, activities] = await Promise.all([
                fetchFromStrava('/athlete'),
                fetchFromStrava('/athlete/activities?per_page=50'),
            ]);

            // Fetch YTD + all-time stats (non-blocking — don't fail chat if this fails)
            let athleteStats = {};
            try {
                athleteStats = await fetchFromStrava(`/athletes/${athlete.id}/stats`);
            } catch (_) {}

            // Build rich, pre-computed context block
            const stravaContext = await buildStravaContext(athlete, activities, athleteStats);

            const systemWithContext = STRAVA_SYSTEM +
                `\n\n${'═'.repeat(50)}\nLIVE STRAVA DATA (fetched ${new Date().toLocaleTimeString()})\n${'═'.repeat(50)}\n${stravaContext}\n${'═'.repeat(50)}\n\nAnswer the user's question using ONLY the data above. Quote specific numbers and dates.`;

            console.log(`[Chat/strava] Context: ${stravaContext.length} chars, ${activities.length} activities`);

            // MCP toolset — best-effort supplement for deep queries (e.g. specific segment data)
            let stravaMcpToolset = null;
            try {
                stravaMcpToolset = createStdioMcpToolset(
                    path.join(__dirname, '../node_modules/.bin/strava-mcp-server'),
                    {
                        STRAVA_ACCESS_TOKEN:  tokens.ACCESS_TOKEN  || '',
                        STRAVA_REFRESH_TOKEN: tokens.REFRESH_TOKEN || '',
                        STRAVA_CLIENT_ID:     tokens.CLIENT_ID     || '',
                        STRAVA_CLIENT_SECRET: tokens.CLIENT_SECRET || '',
                    }
                );
            } catch (e) {
                console.warn('[Chat/strava] MCP toolset creation failed (non-fatal):', e.message);
            }

            const stravaAgent = new LlmAgent({
                name:        'strava_chat',
                model:       MODEL,
                instruction: systemWithContext,
                tools:       stravaMcpToolset ? [stravaMcpToolset] : [],
            });

            try {
                const reply = await runAgent(
                    stravaAgent,
                    userMessage,
                    stravaMcpToolset ? [stravaMcpToolset] : []
                );
                return res.json({ reply });
            } catch (agentErr) {
                console.warn('[Chat/strava] ADK agent error, falling back to no-MCP:', agentErr.message);
                const fallbackAgent = new LlmAgent({
                    name:        'strava_chat_fallback',
                    model:       MODEL,
                    instruction: systemWithContext,
                    tools:       [],
                });
                const reply = await runAgent(fallbackAgent, userMessage);
                return res.json({ reply });
            }
        }

        // Step 3b: General fitness — ADK LlmAgent + Google Search
        const fitnessAgent = new LlmAgent({
            name:        'fitness_chat',
            model:       MODEL,
            instruction: FITNESS_SYSTEM,
            tools:       [GOOGLE_SEARCH],
        });

        const reply = await runAgent(fitnessAgent, userMessage);
        return res.json({ reply });

    } catch (error) {
        console.error("CHAT ERROR:", error.message);
        res.status(500).json({ error: "Failed to communicate with Assistant: " + error.message });
    }
};
