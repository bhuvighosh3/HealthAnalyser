/**
 * Nutrition RAG Service
 * Uses Firecrawl /search to dynamically retrieve authoritative sports-nutrition
 * content and structures it into topic-labelled sections for injection into the
 * Nutrition ADK agent as grounding context.
 *
 * Requires: FIRECRAWL_API_KEY in .env
 * Falls back to empty context (Gemini uses its own training data) if key is absent.
 */

const { FirecrawlClient } = require('@mendable/firecrawl-js');

// ── Search queries per goal category ─────────────────────────────────────────
// Queries target authoritative sources: WHO, Harvard HSPH, Johns Hopkins, NHS
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

// Topic labels mapped to keyword patterns
const TOPIC_LABELS = {
    'PRE-WORKOUT NUTRITION':      ['before exercise', 'pre-run', 'pre-workout', 'before training', 'fueling before', '1-2 hours before', 'pre-race'],
    'POST-WORKOUT RECOVERY':      ['after exercise', 'post-run', 'post-workout', 'recovery meal', 'muscle repair', 'refuel', 'within 30', 'replenish'],
    'CARBOHYDRATES FOR ATHLETES': ['carbohydrate', 'glycogen', 'carb loading', 'starch', 'glucose', 'energy stores', 'pasta', 'rice', 'oats'],
    'PROTEIN & MUSCLE REPAIR':    ['protein', 'amino acid', 'muscle repair', 'lean protein', 'rebuild', 'leucine', 'whey', 'plant protein'],
    'HYDRATION & ELECTROLYTES':   ['hydrat', 'water intake', 'electrolyte', 'sodium', 'sweat loss', 'sports drink', 'dehydration'],
    'RACE-DAY NUTRITION':         ['race day', 'marathon morning', 'competition day', 'before a race', 'race nutrition'],
    'WEIGHT MANAGEMENT':          ['weight loss', 'calorie deficit', 'fat loss', 'body weight', 'BMI', 'body composition'],
    'DAILY NUTRITION TARGETS':    ['daily calorie', 'macronutrient', 'daily intake', 'macro ratio', 'caloric needs'],
    'GENERAL SPORTS NUTRITION':   [],   // catch-all
};

// In-memory cache: key = goalCategory, value = { context, ts }
const CACHE = {};
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        if (keywords.length === 0) continue;
        if (keywords.some(kw => t.includes(kw))) return label;
    }
    return 'GENERAL SPORTS NUTRITION';
}

/**
 * Convert a search result's markdown content into topic-labelled sections.
 * Groups clean paragraphs under their detected topic header.
 */
function structureContent(title, markdown) {
    if (!markdown) return '';
    const lines = markdown.split(/\n{2,}/);
    const sections = {};

    for (const line of lines) {
        // Strip image markdown, links, and formatting symbols
        const clean = line
            .replace(/!\[.*?\]\(.*?\)/g, '')        // remove images
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // keep link text, drop URL
            .replace(/[#*`>\-]+/g, '')
            .trim();
        if (clean.length < 80)  continue;   // skip short stubs / navigation
        if (clean.length > 1500) continue;  // skip giant blobs
        const topic = detectTopic(clean);
        if (!sections[topic]) sections[topic] = [];
        if (sections[topic].length < 3) {   // max 3 paragraphs per topic
            sections[topic].push(clean.slice(0, 600));
        }
    }

    const built = Object.entries(sections)
        .filter(([, paras]) => paras.length > 0)
        .map(([label, paras]) => `## ${label}\n${paras.join('\n')}`)
        .join('\n\n');

    return built ? `<!-- Source: ${title} -->\n${built}` : '';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search, scrape and structure nutrition context for the given goal.
 * Returns a labelled markdown string ready for injection into the agent prompt.
 * Falls back to '' if FIRECRAWL_API_KEY is absent or all searches fail.
 *
 * @param {string} goal  User's fitness goal (free text)
 * @returns {Promise<string>}
 */
async function getNutritionContext(goal) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
        console.warn('[NutritionRAG] No FIRECRAWL_API_KEY — using model knowledge only.');
        return '';
    }

    const category = classifyGoal(goal);

    // Return from cache if still fresh
    const cached = CACHE[category];
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        console.log(`[NutritionRAG] Cache hit for "${category}" (${cached.context.length} chars)`);
        return cached.context;
    }

    const queries = SEARCH_QUERIES[category] || SEARCH_QUERIES.general;
    console.log(`[NutritionRAG] Searching Firecrawl for goal="${goal}" (category=${category}) — ${queries.length} queries`);

    const fc = new FirecrawlClient({ apiKey });
    const allSections = [];

    // Run queries in parallel — best-effort (failures don't block the response)
    const results = await Promise.allSettled(
        queries.map(q =>
            fc.search(q, { limit: 2, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } })
        )
    );

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[NutritionRAG] Search failed:', r.reason?.message?.slice(0, 80));
            continue;
        }
        // Firecrawl search returns r.web as an array-like object with numeric keys
        const webObj = r.value?.web || {};
        const items  = Array.isArray(webObj) ? webObj : Object.values(webObj);
        for (const item of items) {
            const md    = item.markdown || item.content || '';
            const title = item.title    || item.url    || 'source';
            if (md.length > 300) {
                const structured = structureContent(title, md);
                if (structured) allSections.push(structured);
            }
        }
    }

    const context = allSections.join('\n\n---\n\n');
    console.log(`[NutritionRAG] Built ${context.length} chars of nutrition context from ${allSections.length} pages`);

    CACHE[category] = { context, ts: Date.now() };
    return context;
}

module.exports = { getNutritionContext, classifyGoal };
