const { runAgent, LlmAgent, MODEL } = require('../services/adkService');
const { fetchFromStrava } = require('../services/stravaService');
const { getNutritionContext } = require('../services/nutritionRagService');

// ── Nutrition Agent Endpoint ──────────────────────────────────────────────────
// Invoked by the "AI Nutrition Plan" button after forecast results are available.
// Uses RAG context crawled by Firecrawl + athlete's live Strava stats.

exports.nutritionPlan = async (req, res) => {
    const {
        goal = 'General Fitness',
        age = 25,
        weight = 70,
        height = 170,
        sex = 'male',
        weeklyDistKm,
        weeklyHours,
        weeklyKcal,
        durationWeeks = 8,
        allergies = null,
        dislikes = null,
    } = req.body;

    try {
        // ── Step 1: Fetch live Strava context ────────────────────────────────
        let stravaContext = '';
        try {
            const activities = await fetchFromStrava('/athlete/activities?per_page=20');
            const recent = activities.slice(0, 7);
            stravaContext = `Recent ${recent.length} activities:\n` + recent.map(a =>
                `• ${new Date(a.start_date).toDateString()} | ${a.type} | ${(a.distance/1000).toFixed(1)} km | ${Math.round(a.moving_time/60)} min`
            ).join('\n');
        } catch (e) {
            console.warn('[Nutrition] Could not fetch Strava data:', e.message);
        }

        // ── Step 2: Fetch RAG nutrition context via Firecrawl ────────────────
        const ragContext = await getNutritionContext(goal);

        // ── Step 3: Build ADK LlmAgent instruction with RAG grounding ────────
        const bmi = parseFloat((weight / ((height / 100) ** 2)).toFixed(1));
        const ragSection = ragContext
            ? `## RETRIEVED NUTRITION KNOWLEDGE (from authoritative sports-nutrition sources)\n${ragContext}\n\nUse the above evidence-based content to inform your recommendations.`
            : '## NOTE\nNo external nutrition sources available — draw on your training knowledge.';

        const instruction = `You are a world-class sports nutritionist specialising in endurance athletics and performance fuelling.
Your recommendations must be evidence-based, personalised, and actionable.

${ragSection}

## ATHLETE PROFILE
- Age: ${age} | Sex: ${sex} | Weight: ${weight} kg | Height: ${height} cm | BMI: ${bmi}
- Fitness Goal: "${goal}"
- Training timeline: ${durationWeeks} weeks
- Avg weekly distance: ${weeklyDistKm ?? 'unknown'} km
- Avg weekly active time: ${weeklyHours ?? 'unknown'} hrs
- Avg weekly calories burned: ${weeklyKcal ?? 'unknown'} kcal

## DIETARY RESTRICTIONS
- Allergies: ${allergies || 'None reported'}
- Dislikes:  ${dislikes  || 'None reported'}
IMPORTANT: Never suggest any food the athlete is allergic to. Avoid foods they dislike entirely — do not mention them even as alternatives.

## RECENT TRAINING (from Strava)
${stravaContext || 'No activity data available.'}

## YOUR TASK
Create a highly personalised, practical nutrition plan addressing:
1. Daily calorie and macronutrient targets
2. Pre/during/post-workout fuelling
3. Meal timing strategies
4. Hydration and electrolyte protocol
5. Supplement recommendations (if applicable)
6. Goal-specific nutrition adjustments

Be specific: give gram amounts, example foods, and timing windows.`;

        const nutritionAgent = new LlmAgent({
            name:        'nutrition_agent',
            model:       MODEL,
            instruction,
            tools:       [],   // RAG context injected via instruction; no live tools needed
        });

        console.log('[Nutrition] Running ADK nutrition agent...');
        const userPrompt = `Create my personalised nutrition plan for the goal: "${goal}". Focus on practical, specific advice I can implement immediately.

FORMATTING RULES — follow these exactly:
- Use ## for main section headings (e.g. ## Pre-Workout Fuelling)
- Use **bold** only for key numbers, food names, and labels
- Use bullet points (- item) for lists and tips
- Use numbered lists (1. 2. 3.) for step-by-step instructions
- Do NOT use #### or deeper heading levels
- Do NOT use raw asterisks at the start of a line as bullets — use - instead
- Keep the plan clear, scannable, and practical`;

        let planText = await runAgent(nutritionAgent, userPrompt);

        // Parse structured output if model returns JSON, otherwise wrap as freeform
        let plan;
        try {
            const cleaned = planText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            plan = JSON.parse(cleaned);
        } catch (_) {
            // Model returned prose — return as-is
            plan = { prose: planText };
        }

        console.log(`[Nutrition] Plan generated (${planText.length} chars)`);
        res.json({ plan, ragUsed: !!ragContext });

    } catch (err) {
        console.error('[Nutrition Error]', err.message);
        res.status(500).json({ error: 'Failed to generate nutrition plan: ' + err.message });
    }
};
