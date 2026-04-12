const { generateText } = require('../services/aiService');
const { fetchFromStrava } = require('../services/stravaService');

// MET values (metabolic equivalent) per activity type
// Calories burned = MET × weight_kg × duration_hours
const MET = {
    Run:        9.8,
    VirtualRun: 9.8,
    TrailRun:   10.5,
    Treadmill:  9.0,
    Hike:       5.3,
    Ride:       7.5,
    VirtualRide:7.0,
    Walk:       3.5,
    Swim:       8.0,
    Workout:    5.0,
    WeightTraining: 4.0,
    Yoga:       3.0,
};

function estimateCalories(type, weightKg, movingTimeSec) {
    const met = MET[type] || 6.0;
    return Math.round(met * weightKg * (movingTimeSec / 3600));
}

// Estimate VO2max from recent run paces (Jack Daniels approximation)
function estimateVO2Max(activities) {
    const runs = activities
        .filter(a => ['Run', 'VirtualRun', 'TrailRun'].includes(a.type) && a.distance > 2000 && a.average_speed > 0)
        .slice(0, 10);
    if (!runs.length) return null;
    // Speed in m/min, then VO2 = -4.60 + 0.182258 * v + 0.000104 * v^2 (Cooper)
    const avgSpeedMPerMin = runs.reduce((s, r) => s + r.average_speed * 60, 0) / runs.length;
    const vo2 = -4.60 + 0.182258 * avgSpeedMPerMin + 0.000104 * (avgSpeedMPerMin ** 2);
    return Math.round(Math.max(vo2, 20));
}

exports.forecast = async (req, res) => {
    try {
        const {
            age    = 25,
            weight = 70,
            height = 170,
            sex    = 'male',
            goal,
            target = '',
            durationWeeks = 12,
        } = req.body;

        if (!goal) return res.status(400).json({ error: 'Goal is required.' });

        // ── Fetch Strava data ─────────────────────────────────────────────────
        const [activities, athlete] = await Promise.all([
            fetchFromStrava('/athlete/activities?per_page=50'),
            fetchFromStrava('/athlete'),
        ]);
        const stats = await fetchFromStrava(`/athletes/${athlete.id}/stats`);

        // ── Enrich each activity with estimated calorie burn ──────────────────
        const enriched = activities.map(a => ({
            name:          a.name,
            type:          a.type,
            date:          a.start_date_local?.slice(0, 10),
            distanceKm:    parseFloat((a.distance / 1000).toFixed(2)),
            movingTimeMin: Math.round(a.moving_time / 60),
            paceMinPerKm:  a.distance > 0
                ? parseFloat(((a.moving_time / 60) / (a.distance / 1000)).toFixed(2))
                : null,
            avgSpeedKmh:   parseFloat((a.average_speed * 3.6).toFixed(1)),
            elevationM:    Math.round(a.total_elevation_gain || 0),
            avgHR:         a.average_heartrate ?? null,
            sufferScore:   a.suffer_score ?? null,
            estimatedKcal: estimateCalories(a.type, weight, a.moving_time),
        }));

        // Last-28-days aggregate
        const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
        const recent = enriched.filter(a => new Date(a.date) >= new Date(cutoff));
        const weeklyKcal     = Math.round(recent.reduce((s, a) => s + a.estimatedKcal, 0) / 4);
        const weeklyDistKm   = parseFloat((recent.reduce((s, a) => s + a.distanceKm, 0) / 4).toFixed(1));
        const weeklyHours    = parseFloat((recent.reduce((s, a) => s + a.movingTimeMin, 0) / 60 / 4).toFixed(1));
        const weeklyActs     = parseFloat((recent.length / 4).toFixed(1));
        const estimatedVO2   = estimateVO2Max(activities);
        const bmi            = parseFloat((weight / ((height / 100) ** 2)).toFixed(1));

        const weeklySummary = { weeklyKcal, weeklyDistKm, weeklyHours, weeklyActs, estimatedVO2, bmi };

        // ════════════════════════════════════════════════════════════════════
        // AGENT 1 — Hypothesis Check Agent
        // ════════════════════════════════════════════════════════════════════
        const hypothesisPrompt = `You are a sports science expert and fitness data analyst.

## USER PROFILE
- Age: ${age} | Sex: ${sex} | Weight: ${weight} kg | Height: ${height} cm | BMI: ${bmi}
- Fitness Goal: "${goal}"
- Specific Target: "${target || 'not specified'}"
- Time Available: ${durationWeeks} weeks

## CURRENT WEEKLY PERFORMANCE (28-day avg)
- Calories burned: ~${weeklyKcal} kcal/week
- Distance covered: ~${weeklyDistKm} km/week
- Active time: ~${weeklyHours} hrs/week
- Activities per week: ~${weeklyActs}
- Estimated VO2max: ${estimatedVO2 ?? 'unavailable'}
- BMI: ${bmi}

## LAST 20 ACTIVITIES
${JSON.stringify(enriched.slice(0, 20), null, 2)}

## PHYSIOLOGICAL CONSTANTS TO USE
- Calorie calculation: MET × weight_kg × hours (MET: Run=9.8, Hike=5.3, Ride=7.5)
- 1 kg body fat ≈ 7,700 kcal deficit
- Safe weight loss: max 0.5–1 kg/week
- Pace improvement: ~5–10 sec/km per month with structured training
- VO2max improvement: ~3–5% per 4 weeks of consistent aerobic work
- BMR (Mifflin-St Jeor): ${sex === 'female' ? `(10×${weight})+(6.25×${height})-(5×${age})-161` : `(10×${weight})+(6.25×${height})-(5×${age})+5`}

Rigorously validate whether the goal is achievable in ${durationWeeks} weeks.

Return ONLY a valid JSON object (no markdown, no code fences):
{
  "feasibility": "achievable" | "challenging" | "unrealistic",
  "feasibilityScore": <integer 0–100>,
  "currentState": {
    "weeklyKcal": <number>,
    "weeklyDistKm": <number>,
    "weeklyHours": <number>,
    "estimatedVO2Max": <number or null>,
    "bmi": <number>
  },
  "requiredState": {
    "weeklyKcal": <number>,
    "weeklyDistKm": <number>,
    "weeklyHours": <number>,
    "notes": "<what needs to change>"
  },
  "projections": {
    "weeksToGoal": <number>,
    "estimatedProgressByDeadline": "<e.g. 70% of target>",
    "totalKcalBurnedByDeadline": <number>,
    "expectedWeightChangeKg": <number or null>
  },
  "assumptions": ["<assumption 1>", "<assumption 2>", "<assumption 3>"],
  "gaps": ["<gap 1>", "<gap 2>"],
  "riskFactors": ["<risk 1>"],
  "summary": "<2–3 sentences summarising feasibility>"
}`;

        let hypText = await generateText(hypothesisPrompt);
        hypText = hypText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
                         .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ');
        const hypothesis = JSON.parse(hypText);
        console.log(`[Forecast] Hypothesis: ${hypothesis.feasibility} (${hypothesis.feasibilityScore}/100)`);

        // ════════════════════════════════════════════════════════════════════
        // AGENT 2 — Recommendation Agent  [HANDOFF from Hypothesis Agent]
        // ════════════════════════════════════════════════════════════════════
        const recommendationPrompt = `You are a world-class personal running coach and sports nutritionist.

## [HANDOFF FROM HYPOTHESIS CHECK AGENT]
The hypothesis validation agent analysed this athlete's goal and produced the following verified findings.
You MUST base all recommendations on these findings — do not override them.

${JSON.stringify(hypothesis, null, 2)}

## ATHLETE CONTEXT
- Age: ${age} | Sex: ${sex} | Weight: ${weight} kg | Height: ${height} cm
- Goal: "${goal}"  |  Target: "${target || 'not specified'}"  |  Timeline: ${durationWeeks} weeks
- Feasibility verdict: ${hypothesis.feasibility} (${hypothesis.feasibilityScore}/100)
- Current weekly: ${weeklyKcal} kcal | ${weeklyDistKm} km | ${weeklyHours} hrs
- Required weekly: ${hypothesis.requiredState?.weeklyKcal ?? '?'} kcal | ${hypothesis.requiredState?.weeklyDistKm ?? '?'} km

## YOUR TASK
Design a highly personalised, progressive plan that bridges the gap identified by the hypothesis agent.
Address every identified gap and risk factor. Scale intensity/volume based on feasibility score.

Return ONLY a valid JSON object (no markdown, no code fences):
{
  "weeklyTrainingPlan": [
    {
      "day": "<day name>",
      "workout": "<specific workout description>",
      "duration": "<e.g. 45 min>",
      "intensity": "easy" | "moderate" | "hard" | "rest",
      "targetHR": "<e.g. 130–145 bpm or N/A>",
      "purpose": "<why this session>"
    }
  ],
  "nutritionTips": [
    { "title": "<tip title>", "detail": "<specific advice>", "icon": "apple | flame | droplets | zap | salad" }
  ],
  "recoveryAdvice": [
    { "title": "<title>", "detail": "<specific advice>" }
  ],
  "weeklyTargets": {
    "distanceKm": <number>,
    "kcal": <number>,
    "activeHours": <number>,
    "longRunKm": <number>
  },
  "milestones": [
    { "week": <number>, "target": "<measurable milestone>" }
  ],
  "coachNote": "<personalised 2–3 sentence motivational note directly to the athlete>"
}`;

        let recText = await generateText(recommendationPrompt);
        recText = recText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
                         .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ');
        const recommendations = JSON.parse(recText);
        console.log(`[Forecast] Recommendations ready — ${recommendations.weeklyTrainingPlan?.length} training days, ${recommendations.milestones?.length} milestones`);

        res.json({ hypothesis, recommendations, weeklySummary });

    } catch (err) {
        console.error('[Forecast Error]', err.message);
        res.status(500).json({ error: 'Failed to generate forecast: ' + err.message });
    }
};
