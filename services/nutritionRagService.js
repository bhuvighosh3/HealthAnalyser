/**
 * Nutrition RAG Service
 *
 * Flow:
 *  1. Check Firestore vector store for fresh chunks (TTL = 7 days).
 *  2. If stale/empty → crawl via Firecrawl /search, extract topic-labelled chunks,
 *     embed each with Vertex AI text-embedding-004, store in Firestore.
 *  3. Run semantic search (Firestore findNearest, or cosine fallback) for the
 *     user's goal, return top-K chunks formatted as a labelled context string.
 *
 * Requires: FIRECRAWL_API_KEY in env (fallback: model uses own knowledge).
 */

const { FirecrawlClient } = require('@mendable/firecrawl-js');
const { storeChunks, semanticSearch, hasValidChunks, chunksToContext } = require('./vectorStoreService');

// ── Search queries per goal category ─────────────────────────────────────────
const SEARCH_QUERIES = {
    running: [
        'runner diet nutrition carbohydrates protein hydration site:hopkinsmedicine.org OR site:nutritionsource.hsph.harvard.edu',
        'pre run post run nutrition fueling electrolytes endurance athletes',
        'marathon training nutrition plan calories macros',
    ],
    weight_loss: [
        'healthy diet weight management WHO nutrition guidelines site:who.int OR site:nutritionsource.hsph.harvard.edu',
        'calorie deficit weight loss nutrition for active people running',
        'fat loss athlete nutrition macros timing guide',
    ],
    cycling: [
        'endurance cycling nutrition carbohydrate loading hydration electrolytes site:hopkinsmedicine.org OR site:nutritionsource.hsph.harvard.edu',
        'cyclist nutrition plan calories macros race day fueling',
    ],
    general: [
        'healthy diet WHO fact sheet nutrition guidelines site:who.int',
        'sports nutrition fundamentals carbohydrates protein fat athletes site:nutritionsource.hsph.harvard.edu OR site:hopkinsmedicine.org',
        'athlete nutrition plan macros hydration pre post workout',
    ],
};

// Topic labels and keyword matchers for chunk classification
const TOPIC_LABELS = {
    'PRE-WORKOUT NUTRITION':      ['before exercise', 'pre-run', 'pre-workout', 'before training', 'fueling before', '1-2 hours before', 'pre-race'],
    'POST-WORKOUT RECOVERY':      ['after exercise', 'post-run', 'post-workout', 'recovery meal', 'muscle repair', 'refuel', 'within 30', 'replenish'],
    'CARBOHYDRATES FOR ATHLETES': ['carbohydrate', 'glycogen', 'carb loading', 'starch', 'glucose', 'energy stores', 'pasta', 'rice', 'oats'],
    'PROTEIN & MUSCLE REPAIR':    ['protein', 'amino acid', 'muscle repair', 'lean protein', 'rebuild', 'leucine', 'whey', 'plant protein'],
    'HYDRATION & ELECTROLYTES':   ['hydrat', 'water intake', 'electrolyte', 'sodium', 'sweat loss', 'sports drink', 'dehydration'],
    'RACE-DAY NUTRITION':         ['race day', 'marathon morning', 'competition day', 'before a race', 'race nutrition'],
    'WEIGHT MANAGEMENT':          ['weight loss', 'calorie deficit', 'fat loss', 'body weight', 'BMI', 'body composition'],
    'DAILY NUTRITION TARGETS':    ['daily calorie', 'macronutrient', 'daily intake', 'macro ratio', 'caloric needs'],
};

function classifyGoal(goal = '') {
    const g = goal.toLowerCase();
    if (g.includes('run') || g.includes('marathon') || g.includes('5k') || g.includes('10k') || g.includes('pace')) return 'running';
    if (g.includes('weight') || g.includes('fat') || g.includes('slim') || g.includes('lose')) return 'weight_loss';
    if (g.includes('cycl') || g.includes('bike') || g.includes('triathlon')) return 'cycling';
    return 'general';
}

function detectTopic(text) {
    const t = text.toLowerCase();
    for (const [label, keywords] of Object.entries(TOPIC_LABELS)) {
        if (keywords.some(kw => t.includes(kw))) return label;
    }
    return 'GENERAL SPORTS NUTRITION';
}

/**
 * Parse scraped markdown into an array of {topic, text, source} chunk objects.
 * Each chunk = one substantive paragraph classified by topic keyword matching.
 */
function extractChunks(markdown, sourceTitle) {
    if (!markdown) return [];
    const chunks = [];
    const lines  = markdown.split(/\n{2,}/);

    for (const line of lines) {
        const clean = line
            .replace(/!\[.*?\]\(.*?\)/g, '')         // strip images
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // keep link text
            .replace(/[#*`>\-]+/g, '')
            .trim();

        if (clean.length < 80 || clean.length > 1500) continue;  // skip nav/blobs

        chunks.push({
            topic:  detectTopic(clean),
            text:   clean.slice(0, 700),
            source: sourceTitle,
        });
    }
    return chunks;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get grounding context for the given goal.
 *
 * On first call (or after TTL): crawls Firecrawl, embeds chunks, stores in Firestore.
 * On subsequent calls: semantic search against Firestore — no HTTP crawl needed.
 *
 * @param {string} goal  User's fitness goal
 * @returns {Promise<string>}  Topic-labelled markdown context string
 */
async function getNutritionContext(goal) {
    const category = classifyGoal(goal);

    // ── Step 1: Check vector store for fresh data ─────────────────────────────
    let vectorsReady = false;
    try {
        vectorsReady = await hasValidChunks(category);
    } catch (e) {
        console.warn('[NutritionRAG] Firestore check failed:', e.message.slice(0, 80));
    }

    // ── Step 2: Crawl + embed + store (only when store is empty/stale) ────────
    if (!vectorsReady) {
        const apiKey = process.env.FIRECRAWL_API_KEY;
        if (!apiKey) {
            console.warn('[NutritionRAG] No FIRECRAWL_API_KEY — skipping crawl, using model knowledge.');
            return '';
        }

        console.log(`[NutritionRAG] Vector store empty/stale for "${category}" — crawling Firecrawl...`);
        const queries = SEARCH_QUERIES[category] || SEARCH_QUERIES.general;
        const fc      = new FirecrawlClient({ apiKey });

        const allChunks = [];
        const results   = await Promise.allSettled(
            queries.map(q =>
                fc.search(q, { limit: 2, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } })
            )
        );

        for (const r of results) {
            if (r.status === 'rejected') {
                console.warn('[NutritionRAG] Search error:', r.reason?.message?.slice(0, 60));
                continue;
            }
            const webObj = r.value?.web || {};
            const items  = Array.isArray(webObj) ? webObj : Object.values(webObj);
            for (const item of items) {
                if ((item.markdown || item.content || '').length > 300) {
                    const chunks = extractChunks(item.markdown || item.content, item.title || item.url || 'source');
                    allChunks.push(...chunks);
                }
            }
        }

        console.log(`[NutritionRAG] Extracted ${allChunks.length} chunks → embedding + storing in Firestore...`);

        try {
            await storeChunks(category, allChunks);
            vectorsReady = true;
        } catch (e) {
            console.warn('[NutritionRAG] Failed to store vectors:', e.message.slice(0, 80));
            // Still try to return a context from the raw chunks (no vector search)
            if (allChunks.length) {
                const byTopic = {};
                for (const c of allChunks.slice(0, 20)) {
                    if (!byTopic[c.topic]) byTopic[c.topic] = [];
                    if (byTopic[c.topic].length < 2) byTopic[c.topic].push(c.text);
                }
                return Object.entries(byTopic)
                    .map(([t, texts]) => `## ${t}\n${texts.join('\n')}`)
                    .join('\n\n');
            }
            return '';
        }
    }

    // ── Step 3: Semantic search — retrieve top-K relevant chunks ─────────────
    try {
        const chunks  = await semanticSearch(goal, category, 8);
        const context = chunksToContext(chunks);
        console.log(`[NutritionRAG] Semantic search returned ${chunks.length} chunks (${context.length} chars) for goal="${goal}"`);
        return context;
    } catch (e) {
        console.warn('[NutritionRAG] Semantic search failed:', e.message.slice(0, 80));
        return '';
    }
}

module.exports = { getNutritionContext, classifyGoal };
