const { generateText } = require('../services/aiService');
const { fetchFromStrava } = require('../services/stravaService');
const { runAgent, FunctionTool, LlmAgent, MODEL } = require('../services/adkService');

// MET values (metabolic equivalent) per activity type
// Calories burned = MET × weight_kg × duration_hours
const MET = {
    Run:         9.8,
    VirtualRun:  9.8,
    TrailRun:    10.5,
    Treadmill:   9.0,
    Hike:        5.3,
    Ride:        7.5,
    VirtualRide: 7.0,
    Walk:        3.5,
    Swim:        8.0,
    Workout:     5.0,
    WeightTraining: 4.0,
    Yoga:        3.0,
};

const RUN_TYPES = new Set(['Run', 'VirtualRun', 'TrailRun', 'Treadmill']);

function estimateCalories(type, weightKg, movingTimeSec) {
    const met = MET[type] || 6.0;
    return Math.round(met * weightKg * (movingTimeSec / 3600));
}

// Estimate VO2max from recent run paces (Jack Daniels approximation)
function estimateVO2Max(activities) {
    const runs = activities
        .filter(a => RUN_TYPES.has(a.type) && a.distance > 2000 && a.average_speed > 0)
        .slice(0, 10);
    if (!runs.length) return null;
    const avgSpeedMPerMin = runs.reduce((s, r) => s + r.average_speed * 60, 0) / runs.length;
    const vo2 = -4.60 + 0.182258 * avgSpeedMPerMin + 0.000104 * (avgSpeedMPerMin ** 2);
    return Math.round(Math.max(vo2, 20));
}

// ── EDA: Statistical Analysis — deterministic tool executor ──────────────────
function computeTrainingMetrics(metric, activities) {
    const runs = activities.filter(a => RUN_TYPES.has(a.type) && a.distance > 0 && a.moving_time > 0);
    runs.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    const result = {};

    if (metric === 'pace_trend' || metric === 'all') {
        const paces = runs.map(r => (r.moving_time / 60) / (r.distance / 1000));
        const n = paces.length;
        if (n >= 2) {
            const xMean = (n - 1) / 2;
            const yMean = paces.reduce((s, p) => s + p, 0) / n;
            const num = paces.reduce((s, p, i) => s + (i - xMean) * (p - yMean), 0);
            const den = paces.reduce((s, _, i) => s + (i - xMean) ** 2, 0);
            const slope = den !== 0 ? num / den : 0;
            result.pace_trend = {
                avg_min_per_km: parseFloat(yMean.toFixed(2)),
                trend_per_activity_min: parseFloat(slope.toFixed(3)),
                direction: slope < -0.01 ? 'improving (getting faster)' : slope > 0.01 ? 'regressing (slowing down)' : 'stable',
                fastest_pace: parseFloat(Math.min(...paces).toFixed(2)),
                slowest_pace: parseFloat(Math.max(...paces).toFixed(2)),
                sample_size: n
            };
        } else {
            result.pace_trend = { note: 'Insufficient run data', sample_size: n };
        }
    }

    if (metric === 'volume_trend' || metric === 'all') {
        const weeks = {};
        activities.forEach(a => {
            const d = new Date(a.start_date);
            const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
            const key = ws.toISOString().slice(0, 10);
            weeks[key] = (weeks[key] || 0) + a.distance / 1000;
        });
        const weeklyVols = Object.entries(weeks).sort().map(([k, v]) => ({ week: k, km: parseFloat(v.toFixed(1)) }));
        const vols = weeklyVols.map(w => w.km);
        const avgVol = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
        const recentVol = vols.slice(-2).reduce((s, v) => s + v, 0) / Math.min(2, vols.length || 1);
        result.volume_trend = {
            avg_weekly_km: parseFloat(avgVol.toFixed(1)),
            recent_weekly_km: parseFloat(recentVol.toFixed(1)),
            peak_weekly_km: parseFloat(Math.max(...vols, 0).toFixed(1)),
            trend: recentVol > avgVol * 1.1 ? 'increasing' : recentVol < avgVol * 0.9 ? 'decreasing' : 'stable',
            weekly_breakdown: weeklyVols.slice(-6),
            weeks_of_data: weeklyVols.length
        };
    }

    if (metric === 'consistency' || metric === 'all') {
        const fourWeeksAgo = Date.now() - 28 * 24 * 3600 * 1000;
        const recentRuns = runs.filter(a => new Date(a.start_date) >= fourWeeksAgo);
        const weeksWithRun = new Set(recentRuns.map(r => {
            const d = new Date(r.start_date);
            const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
            return ws.toISOString().slice(0, 10);
        }));
        const sorted = [...recentRuns].sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
        const dayGaps = [];
        for (let i = 1; i < sorted.length; i++) {
            dayGaps.push(parseFloat(
                ((new Date(sorted[i].start_date) - new Date(sorted[i - 1].start_date)) / 86400000).toFixed(1)
            ));
        }
        result.consistency = {
            runs_last_4_weeks: recentRuns.length,
            weeks_active: weeksWithRun.size,
            consistency_score_pct: Math.round((weeksWithRun.size / 4) * 100),
            avg_days_between_runs: dayGaps.length ? parseFloat((dayGaps.reduce((s, v) => s + v, 0) / dayGaps.length).toFixed(1)) : null,
            longest_gap_days: dayGaps.length ? parseFloat(Math.max(...dayGaps).toFixed(1)) : null,
            avg_runs_per_week: parseFloat((recentRuns.length / 4).toFixed(1))
        };
    }

    if (metric === 'training_load' || metric === 'all') {
        const recent = [...activities].sort((a, b) => new Date(b.start_date) - new Date(a.start_date)).slice(0, 10);
        const recentRuns = recent.filter(a => RUN_TYPES.has(a.type));
        const avgDur = recent.length ? recent.reduce((s, a) => s + a.moving_time, 0) / recent.length : 0;
        const avgDist = recentRuns.length ? recentRuns.reduce((s, a) => s + a.distance / 1000, 0) / recentRuns.length : 0;
        const hrs = recent.filter(a => a.average_heartrate).map(a => a.average_heartrate);
        const sf = recent.filter(a => a.suffer_score).map(a => a.suffer_score);
        result.training_load = {
            avg_session_min: Math.round(avgDur / 60),
            avg_run_km: parseFloat(avgDist.toFixed(1)),
            avg_heart_rate_bpm: hrs.length ? Math.round(hrs.reduce((s, v) => s + v, 0) / hrs.length) : null,
            avg_suffer_score: sf.length ? Math.round(sf.reduce((s, v) => s + v, 0) / sf.length) : null,
            has_heartrate_data: hrs.length > 0,
            sample_size: recent.length
        };
    }

    return result;
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
            context = '',
        } = req.body;

        if (!goal) return res.status(400).json({ error: 'Goal is required.' });

        // ── Step 1: Collect — fetch all Strava data ───────────────────────────────
        const [activities, athlete] = await Promise.all([
            fetchFromStrava('/athlete/activities?per_page=200'),
            fetchFromStrava('/athlete'),
        ]);
        const stats = await fetchFromStrava(`/athletes/${athlete.id}/stats`);

        const enriched = activities.map(a => ({
            name:             a.name,
            type:             a.type,
            sport_type:       a.sport_type || a.type,
            workout_type:     a.workout_type ?? null,   // 0=default,1=race,2=long_run,3=workout
            date:             a.start_date_local?.slice(0, 10),
            distanceKm:       parseFloat((a.distance / 1000).toFixed(2)),
            movingTimeMin:    Math.round(a.moving_time / 60),
            elapsedTimeMin:   Math.round(a.elapsed_time / 60),
            paceMinPerKm:     a.distance > 0 ? parseFloat(((a.moving_time / 60) / (a.distance / 1000)).toFixed(2)) : null,
            avgSpeedKmh:      parseFloat((a.average_speed * 3.6).toFixed(1)),
            maxSpeedKmh:      parseFloat(((a.max_speed || 0) * 3.6).toFixed(1)),
            elevationM:       Math.round(a.total_elevation_gain || 0),
            elevHighM:        a.elev_high != null ? Math.round(a.elev_high) : null,
            elevLowM:         a.elev_low  != null ? Math.round(a.elev_low)  : null,
            avgHR:            a.average_heartrate ?? null,
            maxHR:            a.max_heartrate     ?? null,
            hasHeartrate:     a.has_heartrate     ?? false,
            sufferScore:      a.suffer_score      ?? null,
            prCount:          a.pr_count          ?? 0,
            achievementCount: a.achievement_count ?? 0,
            kudosCount:       a.kudos_count       ?? 0,
            deviceName:       a.device_name       ?? null,
            location:         [a.location_city, a.location_country].filter(Boolean).join(', ') || null,
            estimatedKcal:    estimateCalories(a.type, weight, a.moving_time),
        }));

        const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
        const recent = enriched.filter(a => new Date(a.date) >= new Date(cutoff));
        const weeklyKcal   = Math.round(recent.reduce((s, a) => s + a.estimatedKcal, 0) / 4);
        const weeklyDistKm = parseFloat((recent.reduce((s, a) => s + a.distanceKm, 0) / 4).toFixed(1));
        const weeklyHours  = parseFloat((recent.reduce((s, a) => s + a.movingTimeMin, 0) / 60 / 4).toFixed(1));
        const weeklyActs   = parseFloat((recent.length / 4).toFixed(1));
        const estimatedVO2 = estimateVO2Max(activities);
        const bmi          = parseFloat((weight / ((height / 100) ** 2)).toFixed(1));
        const weeklySummary = { weeklyKcal, weeklyDistKm, weeklyHours, weeklyActs, estimatedVO2, bmi };

        // ════════════════════════════════════════════════════════════════════════
        // AGENT 1 — EDA Agent  (ADK LlmAgent + FunctionTool)
        // ════════════════════════════════════════════════════════════════════════
        const edaSystem = `You are a sports data analyst performing Exploratory Data Analysis (EDA) on an athlete's Strava training history.
Use the compute_training_metrics tool to statistically analyse the training data. Call it with metric='all' to get the full picture.
After receiving the computed metrics, write a concise EDA report.

FORMATTING RULES — follow these exactly:
- Use ## for section headings (e.g. ## Pace Trend)
- Use **bold** only for key numbers and labels
- Use bullet points (- item) for lists
- Do NOT use #### or deeper heading levels
- Do NOT use raw asterisks for emphasis inside sentences

Structure your report as:
## Key Trends
## Consistency Patterns
## Training Load
## Anomalies & Risk Signals

Be specific — cite actual numbers from the tool results.`;

        const edaUserMsg = `Analyse this athlete's training data.
Goal: "${goal}" | Timeline: ${durationWeeks} weeks | Weight: ${weight} kg | Age: ${age}
${context ? `Context: ${context}` : ''}
Compute all available metrics and produce a statistical EDA summary.`;

        // FunctionTool captures 'activities' from the enclosing scope
        const edaTool = new FunctionTool({
            name:        'compute_training_metrics',
            description: 'Statistically analyse the athlete\'s Strava training data. Returns computed metrics for pace trends (linear regression), volume trends, consistency patterns, and training load.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    metric: {
                        type:        'STRING',
                        enum:        ['pace_trend', 'volume_trend', 'consistency', 'training_load', 'all'],
                        description: 'Which aspect of training data to compute statistics for.',
                    }
                },
                required: ['metric'],
            },
            execute: async ({ metric }) => {
                const result = computeTrainingMetrics(metric || 'all', activities);
                console.log(`[EDA] Tool executed: metric=${metric}`);
                return result;
            },
        });

        const edaAgent = new LlmAgent({
            name:        'eda_agent',
            model:       MODEL,
            instruction: edaSystem,
            tools:       [edaTool],
        });

        const edaSummary = await runAgent(edaAgent, edaUserMsg);
        console.log(`[EDA] Summary ready (${edaSummary.length} chars)`);

        // ════════════════════════════════════════════════════════════════════════
        // AGENT 2 — Hypothesis Check Agent  (structured JSON via generateText)
        // ════════════════════════════════════════════════════════════════════════
        const hypothesisPrompt = `You are a sports science expert and fitness data analyst.

## USER PROFILE
- Age: ${age} | Sex: ${sex} | Weight: ${weight} kg | Height: ${height} cm | BMI: ${bmi}
- Fitness Goal: "${goal}"
- Specific Target: "${target || 'not specified'}"
- Time Available: ${durationWeeks} weeks

## EDA FINDINGS (from statistical analysis agent)
${edaSummary}

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

Use the EDA findings above to rigorously validate whether the goal is achievable in ${durationWeeks} weeks.

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
        console.log(`[Hypothesis] ${hypothesis.feasibility} (${hypothesis.feasibilityScore}/100)`);

        // ════════════════════════════════════════════════════════════════════════
        // AGENT 3 — Recommendation Agent  [HANDOFF from Hypothesis Agent]
        // ════════════════════════════════════════════════════════════════════════
        const recommendationPrompt = `You are a world-class personal running coach.

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
Design a highly personalised, progressive training plan that bridges the gap identified by the hypothesis agent.
Address every identified gap and risk factor. Scale intensity/volume based on feasibility score.
NOTE: Do NOT include nutrition advice — a dedicated AI Nutrition Agent handles that separately.

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
        console.log(`[Recommendations] ${recommendations.weeklyTrainingPlan?.length} training days, ${recommendations.milestones?.length} milestones`);

        res.json({ hypothesis, recommendations, weeklySummary, edaSummary });

    } catch (err) {
        console.error('[Forecast Error]', err.message);
        res.status(500).json({ error: 'Failed to generate forecast: ' + err.message });
    }
};
