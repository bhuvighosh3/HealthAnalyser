const path = require('path');
const { generateText } = require('../services/aiService');
const { fetchFromStrava, tokens, ensureValidToken } = require('../services/stravaService');
const { runAgent, createStdioMcpToolset, LlmAgent, GOOGLE_SEARCH, MODEL } = require('../services/adkService');

// ─── System prompts ──────────────────────────────────────────────────────────

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
User: "What are my heart rate zones?"                 → strava
User: "What was my fastest 5K?"                       → strava
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
User: "What's 2+2?"                                   → off-topic
User: "Tell me a joke"                                → off-topic

Reply with ONLY the single category word: strava, fitness, or off-topic`;

const STRAVA_SYSTEM = `You are an expert Strava running coach embedded in a personal health dashboard.
You have live access to the athlete's Strava account via tools — always use them to fetch real data before answering.

DOMAIN: Personal Strava data and training insights only.

Few-shot refusal examples (for anything outside this domain):
---
User: "What stocks should I buy?"
You: "I'm your personal fitness assistant — I can only help with your Strava data and training. Try asking me about your recent runs!"

User: "Write me some code"
You: "That's outside my area. I specialise in your training data. Ask me about your pace, mileage, or activity history!"

User: "How do I fake my Strava activities?"
You: "I can't help with that. I'm here to support genuine training progress — let's focus on your real workouts!"

User: "What's in the news today?"
You: "I focus on fitness and your Strava data only. How about we look at your recent training instead?"

User: "Can you hack someone's account?"
You: "That's not something I can help with. Ask me about your own activities, stats, or training goals!"
---

When answering legitimate questions:
- Always call the appropriate Strava tool(s) to get real, up-to-date data
- Be specific: reference actual numbers, dates, and activity names from the data
- Convert meters → km, seconds → readable time (e.g. "1h 23m")
- Be encouraging and coach-like in tone`;

const FITNESS_SYSTEM = `You are a knowledgeable running and fitness coach with access to current web information.
Answer general fitness questions: training theory, nutrition, injury prevention, race strategies, exercise science, recovery, and gear.

DOMAIN: Fitness, running, cycling, triathlon, health, and wellbeing ONLY.

Few-shot refusal examples (for anything outside this domain):
---
User: "What's the best programming language?"
You: "I focus exclusively on fitness topics. Ask me about training plans, nutrition, or injury prevention!"

User: "Tell me a joke"
You: "I'm a fitness coach, not a comedian! I can help with training advice, race prep, or recovery tips though."

User: "Help me cheat in a race"
You: "I only support fair, safe athletic performance. I'm happy to help with legitimate training and race strategy!"
---

When answering:
- Use web search to provide current, accurate information
- Give practical, actionable advice with specific examples
- Cite sources where relevant
- Keep answers concise and encouraging`;

const OFF_TOPIC_REPLIES = [
    "I'm your Strava fitness assistant — I can only help with your training data and fitness questions. Try asking about your recent runs or a training tip!",
    "That's outside my domain. I specialise in your Strava data and general fitness advice. What would you like to know about your training?",
    "I focus on fitness and your Strava activities only. Feel free to ask me about your pace, mileage, heart rate zones, or training plans!",
];


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
        // Step 1: Classify intent (simple text call — no tools needed)
        const category = (await generateText(
            [{ role: 'user', parts: [{ text: ROUTER_SYSTEM + '\n\nUser: "' + userMessage + '"' }] }]
        )).trim().toLowerCase().replace(/[^a-z-]/g, '');

        console.log(`[Chat] intent="${category}" message="${userMessage.slice(0, 60)}"`);

        // Step 2: Off-topic → instant refusal, no AI call
        if (category === 'off-topic' || !['strava', 'fitness'].includes(category)) {
            const reply = OFF_TOPIC_REPLIES[Math.floor(Math.random() * OFF_TOPIC_REPLIES.length)];
            return res.json({ reply });
        }

        // Step 3a: Strava — ADK LlmAgent with MCPToolset + pre-fetched REST context
        if (category === 'strava') {
            // Always pre-fetch via REST — guarantees correct answers even if MCP unavailable
            const [athlete, activities] = await Promise.all([
                fetchFromStrava('/athlete'),
                fetchFromStrava('/athlete/activities?per_page=30'),
            ]);

            const today = new Date().toDateString();
            const stravaContext = `Today's date: ${today}
Athlete: ${athlete.firstname} ${athlete.lastname} | ${athlete.city || ''} ${athlete.country || ''} | Sex: ${athlete.sex || 'N/A'}

Recent ${activities.length} activities (newest first):
${activities.slice(0, 20).map(a =>
    `• ${new Date(a.start_date).toDateString()} | ${a.type} | "${a.name}" | ${(a.distance/1000).toFixed(2)} km | ${Math.round(a.moving_time/60)} min${a.average_heartrate ? ` | ${Math.round(a.average_heartrate)} bpm avg HR` : ''}${a.suffer_score ? ` | suffer: ${a.suffer_score}` : ''}`
).join('\n')}`;

            const systemWithContext = STRAVA_SYSTEM +
                `\n\n## LIVE STRAVA DATA (fetched now)\n${stravaContext}\n\nUse this data to answer directly. You may also call MCP tools for more specific queries.`;

            // Build MCP toolset — best-effort, falls back to REST context if unavailable
            let stravaMcpToolset = null;
            try {
                await ensureValidToken();
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
                console.warn('[Chat/strava] MCP toolset unavailable, using REST context only:', e.message);
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
                // If ADK agent fails (e.g. MCP subprocess error), retry without MCP tools
                console.warn('[Chat/strava] ADK agent failed, retrying without MCP:', agentErr.message);
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

        // Step 3b: General fitness — ADK LlmAgent with Google Search grounding
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
