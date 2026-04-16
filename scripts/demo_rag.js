/**
 * demo_rag.js — Full end-to-end RAG agent test case for Rishit.
 * Test only — no production files modified.
 *
 * Run: node scripts/demo_rag.js
 */

require('dotenv').config();

process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
process.env.GOOGLE_CLOUD_PROJECT      = process.env.GCP_PROJECT_ID || 'healthmonitor-493021';
process.env.GOOGLE_CLOUD_LOCATION     = process.env.GCP_LOCATION   || 'us-central1';

const { LlmAgent, MODEL }                                    = require('../services/adkService');
const { Runner, InMemorySessionService, isFinalResponse }    = require('@google/adk');
const { semanticSearch, embed, hasValidChunks, chunksToContext } = require('../services/vectorStoreService');
const { classifyGoal }                                       = require('../services/nutritionRagService');

// ── Test input ────────────────────────────────────────────────────────────────
const INPUT = {
    name:          'Rishit',
    goal:          'marathon training',
    age:           22,
    weight:        68,
    height:        175,
    sex:           'male',
    weeklyDistKm:  45,
    weeklyHours:   5.5,
    weeklyKcal:    2400,
    durationWeeks: 12,
};

const STRAVA = [
    '• Mon Apr 14 2026 | Run | 12.3 km | 68 min  | avg HR 158',
    '• Sat Apr 12 2026 | Run | 21.1 km | 118 min | avg HR 161  (long run)',
    '• Thu Apr 10 2026 | Run |  8.0 km |  43 min | avg HR 152  (easy)',
    '• Tue Apr  8 2026 | Run | 10.5 km |  56 min | avg HR 165  (tempo)',
    '• Sun Apr  6 2026 | Run | 18.0 km | 100 min | avg HR 159',
].join('\n');

// ── Print helpers ─────────────────────────────────────────────────────────────
const W   = 70;
const DIV = '─'.repeat(W);
const BIG = '═'.repeat(W);

function section(n, title) {
    console.log('\n' + BIG);
    console.log(`  STEP ${n}  —  ${title}`);
    console.log(BIG);
}

function wrap(text, indent = '  ') {
    const words = text.split(' ');
    let line = indent;
    for (const w of words) {
        if ((line + w).length > W - 2) { console.log(line); line = indent + w + ' '; }
        else line += w + ' ';
    }
    if (line.trim()) console.log(line);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {

    console.log('\n' + BIG);
    console.log('  AthleteIQ RAG Agent — End-to-End Test Case');
    console.log('  Profile: Rishit  |  Goal: marathon training');
    console.log(BIG);

    // ══════════════════════════════════════════════════════════════
    // STEP 1 — RAW INPUT
    // ══════════════════════════════════════════════════════════════
    section(1, 'RAW INPUT');

    console.log('\n  [Athlete Profile]');
    console.log(DIV);
    Object.entries(INPUT).forEach(([k, v]) =>
        console.log(`  ${k.padEnd(18)}: ${v}`)
    );

    console.log('\n  [Recent Strava Activities]');
    console.log(DIV);
    STRAVA.split('\n').forEach(l => console.log('  ' + l));

    // ══════════════════════════════════════════════════════════════
    // STEP 2 — GOAL CLASSIFICATION
    // ══════════════════════════════════════════════════════════════
    section(2, 'GOAL CLASSIFICATION');

    const category = classifyGoal(INPUT.goal);
    console.log(`\n  classifyGoal("${INPUT.goal}")`);
    console.log(DIV);
    console.log(`  Checks for keywords: run | marathon | 5k | 10k | pace`);
    console.log(`  "marathon" found → category = "${category}"`);
    console.log(`\n  This maps to search queries targeting:`);
    console.log(`    • carbohydrate/glycogen fuelling for runners`);
    console.log(`    • marathon training nutrition plans`);
    console.log(`    • electrolytes / hydration for endurance`);

    // ══════════════════════════════════════════════════════════════
    // STEP 3 — VECTOR STORE CHECK
    // ══════════════════════════════════════════════════════════════
    section(3, 'VECTOR STORE FRESHNESS CHECK');

    console.log(`\n  hasValidChunks("${category}")`);
    console.log(DIV);
    console.log(`  Collection : nutrition_vectors (Firestore)`);
    console.log(`  Filter     : goalCategory == "${category}"`);
    console.log(`  TTL        : 7 days`);
    console.log(`  Checking...`);

    const fresh = await hasValidChunks(category);
    console.log(`\n  Result     : ${fresh ? 'FRESH ✓ — skip Firecrawl crawl' : 'STALE / EMPTY — would crawl Firecrawl'}`);

    // ══════════════════════════════════════════════════════════════
    // STEP 4 — QUERY EMBEDDING
    // ══════════════════════════════════════════════════════════════
    section(4, 'QUERY EMBEDDING  (text-embedding-004)');

    console.log(`\n  embed("${INPUT.goal}")`);
    console.log(DIV);
    console.log(`  Model : text-embedding-004  (Vertex AI)`);
    console.log(`  Embedding...`);

    const queryVec = await embed(INPUT.goal);
    console.log(`\n  Output dim  : ${queryVec.length}`);
    console.log(`  First 8 vals: [${queryVec.slice(0,8).map(v=>v.toFixed(5)).join(', ')}]`);
    console.log(`  Last  8 vals: [${queryVec.slice(-8).map(v=>v.toFixed(5)).join(', ')}]`);
    console.log(`  Min / Max   : ${Math.min(...queryVec).toFixed(5)} / ${Math.max(...queryVec).toFixed(5)}`);
    console.log(`\n  This vector is passed to Firestore findNearest() below.`);

    // ══════════════════════════════════════════════════════════════
    // STEP 5 — SEMANTIC SEARCH (all chunks)
    // ══════════════════════════════════════════════════════════════
    section(5, 'SEMANTIC SEARCH — Firestore findNearest()');

    console.log(`\n  semanticSearch("${INPUT.goal}", "${category}", topK=8)`);
    console.log(DIV);
    console.log(`  Distance measure : COSINE`);
    console.log(`  Searching Firestore...`);

    const chunks = await semanticSearch(INPUT.goal, category, 8);
    console.log(`\n  → ${chunks.length} chunks returned`);
    console.log(DIV);

    chunks.forEach((chunk, i) => {
        console.log(`\n  ── Chunk ${i + 1} / ${chunks.length} ──────────────────────────────────`);
        console.log(`  Topic  : ${chunk.topic}`);
        console.log(`  Source : ${chunk.source || '(none)'}`);
        console.log(`  Score  : ${chunk.score !== null && chunk.score !== undefined ? chunk.score.toFixed(6) : '(native Firestore — not exposed)'}`);
        console.log(`  Text   :`);
        wrap(chunk.text, '    ');
    });

    console.log('\n' + DIV);

    // ══════════════════════════════════════════════════════════════
    // STEP 6 — RAG CONTEXT ASSEMBLY
    // ══════════════════════════════════════════════════════════════
    section(6, 'RAG CONTEXT ASSEMBLY  (chunksToContext)');

    const ragContext = chunksToContext(chunks);
    const topics = ragContext.split('\n').filter(l => l.startsWith('##')).map(l => l.replace('##','').trim());

    console.log(`\n  Groups chunks by topic → markdown sections`);
    console.log(DIV);
    console.log(`  Total chars  : ${ragContext.length}`);
    console.log(`  Topic groups : ${topics.length}`);
    topics.forEach(t => {
        const n = chunks.filter(c => c.topic === t).length;
        console.log(`    • ${t}  (${n} chunk${n>1?'s':''})`);
    });

    console.log(`\n  [Full RAG Context]`);
    console.log(DIV);
    console.log(ragContext);

    // ══════════════════════════════════════════════════════════════
    // STEP 7 — AGENT INPUT CONSTRUCTION
    // ══════════════════════════════════════════════════════════════
    section(7, 'AGENT INPUT CONSTRUCTION');

    const bmi = (INPUT.weight / ((INPUT.height / 100) ** 2)).toFixed(1);

    const systemInstruction = `You are a world-class sports nutritionist specialising in endurance athletics and performance fuelling.
Your recommendations must be evidence-based, personalised, and actionable.

## RETRIEVED NUTRITION KNOWLEDGE (authoritative sports-nutrition sources)
${ragContext}

Use the above evidence-based content to inform your recommendations.

## ATHLETE PROFILE
- Name: ${INPUT.name} | Age: ${INPUT.age} | Sex: ${INPUT.sex}
- Weight: ${INPUT.weight} kg | Height: ${INPUT.height} cm | BMI: ${bmi}
- Fitness Goal: "${INPUT.goal}"
- Training timeline: ${INPUT.durationWeeks} weeks
- Avg weekly distance: ${INPUT.weeklyDistKm} km
- Avg weekly active time: ${INPUT.weeklyHours} hrs
- Avg weekly calories burned: ${INPUT.weeklyKcal} kcal

## RECENT STRAVA TRAINING
${STRAVA}`;

    const userPrompt = `Create a personalised nutrition plan for ${INPUT.name}'s goal: "${INPUT.goal}".
Be specific — give gram amounts, example foods, and timing windows.
Use ## for main sections and bullet points for lists.`;

    console.log(`\n  [System Instruction  (${systemInstruction.length} chars)]`);
    console.log(DIV);
    console.log(systemInstruction);

    console.log(`\n  [User Prompt]`);
    console.log(DIV);
    console.log(userPrompt);

    console.log(`\n  [Agent Config]`);
    console.log(DIV);
    console.log(`  name  : nutrition_agent`);
    console.log(`  model : ${MODEL}  (Vertex AI)`);
    console.log(`  tools : []  — RAG grounding via system instruction, no live tools`);

    // ══════════════════════════════════════════════════════════════
    // STEP 8 — ADK RUNNER + LIVE EVENTS
    // ══════════════════════════════════════════════════════════════
    section(8, 'ADK RUNNER — LIVE EVENTS');

    const sessionService = new InMemorySessionService();
    const agent = new LlmAgent({
        name:        'nutrition_agent',
        model:       MODEL,
        instruction: systemInstruction,
        tools:       [],
    });
    const runner  = new Runner({ agent, appName: 'athleteiq', sessionService });
    const session = await sessionService.createSession({ appName: 'athleteiq', userId: 'rishit' });

    console.log(`\n  Session ID : ${session.id}`);
    console.log(`  User ID    : rishit`);
    console.log(`  App        : athleteiq`);
    console.log(`\n  Streaming events from runner.runAsync() ...\n`);
    console.log(DIV);

    const t0 = Date.now();
    let finalText = '';
    let eventIdx  = 0;

    for await (const event of runner.runAsync({
        userId:     'rishit',
        sessionId:  session.id,
        newMessage: { role: 'user', parts: [{ text: userPrompt }] },
    })) {
        eventIdx++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const author  = event.author || 'unknown';
        const parts   = event.content?.parts ?? [];
        const isFinal = isFinalResponse(event);

        const hasThink = parts.some(p => p.thought);
        const hasTool  = parts.some(p => p.functionCall);
        const hasResp  = parts.some(p => p.functionResponse);
        const hasText  = parts.some(p => p.text && !p.thought);

        let type;
        if (author === 'user')  type = 'USER_INPUT';
        else if (hasThink)      type = 'MODEL_THINKING';
        else if (hasTool)       type = 'TOOL_CALL';
        else if (hasResp)       type = 'TOOL_RESPONSE';
        else if (isFinal)       type = 'FINAL_RESPONSE';
        else if (hasText)       type = 'MODEL_TEXT';
        else                    type = 'INTERNAL';

        console.log(`\n  Event #${eventIdx}  |  +${elapsed}s  |  author: ${author}  |  type: ${type}`);
        console.log(DIV);

        for (const part of parts) {
            if (part.thought) {
                const t = (part.text || '').slice(0, 400).replace(/\n/g,' ');
                console.log(`  [THINKING]  "${t}${(part.text||'').length > 400 ? '...' : ''}"`);
            } else if (part.functionCall) {
                console.log(`  [TOOL CALL]  ${part.functionCall.name}`);
                console.log(`  Args: ${JSON.stringify(part.functionCall.args)}`);
            } else if (part.functionResponse) {
                const r = JSON.stringify(part.functionResponse.response).slice(0, 300);
                console.log(`  [TOOL RESPONSE]  ${part.functionResponse.name}`);
                console.log(`  Result: ${r}`);
            } else if (part.text && isFinal) {
                finalText = part.text;
                console.log(`  [FINAL TEXT]  ${part.text.length.toLocaleString()} chars`);
                console.log(`  Preview: "${part.text.slice(0, 160).replace(/\n/g,' ')}..."`);
            } else if (part.text) {
                console.log(`  [TEXT]  "${part.text.slice(0, 160).replace(/\n/g,' ')}"`);
            }
        }

        if (event.actions?.stateDelta && Object.keys(event.actions.stateDelta).length) {
            console.log(`  [STATE]  ${JSON.stringify(event.actions.stateDelta)}`);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 9 — FINAL OUTPUT
    // ══════════════════════════════════════════════════════════════
    const totalMs = Date.now() - t0;
    section(9, 'FINAL OUTPUT — Nutrition Plan for Rishit');
    console.log();
    console.log(finalText);

    // ══════════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + BIG);
    console.log('  TEST CASE SUMMARY');
    console.log(BIG);
    console.log(`  Input goal          : "${INPUT.goal}"`);
    console.log(`  Classified as       : "${category}"`);
    console.log(`  Query vector dim    : ${queryVec.length}`);
    console.log(`  Vector store        : FRESH (no crawl needed)`);
    console.log(`  Chunks retrieved    : ${chunks.length}  (COSINE, Firestore findNearest)`);
    console.log(`  RAG context chars   : ${ragContext.length}`);
    console.log(`  System instr chars  : ${systemInstruction.length}`);
    console.log(`  ADK events fired    : ${eventIdx}`);
    console.log(`  Model               : ${MODEL}  (Vertex AI)`);
    console.log(`  Agent response time : ${(totalMs/1000).toFixed(1)} s`);
    console.log(`  Output chars        : ${finalText.length.toLocaleString()}`);
    console.log(BIG + '\n');

})().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
