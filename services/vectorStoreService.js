/**
 * Vector Store Service — Firestore-backed semantic search using Vertex AI embeddings.
 *
 * Nutrition text chunks are embedded with text-embedding-004 (Vertex AI) and stored
 * in a Firestore collection with a native vector field.  At query time the user's goal
 * is embedded and Firestore's findNearest() returns the most similar chunks instantly —
 * no Firecrawl call needed once the store is populated.
 *
 * GCP setup (run once):
 *   gcloud services enable firestore.googleapis.com --project <PROJECT>
 *   gcloud firestore databases create --location=us-central1 --project <PROJECT>
 *   gcloud projects add-iam-policy-binding <PROJECT> \
 *     --member="serviceAccount:<NUMBER>-compute@developer.gserviceaccount.com" \
 *     --role="roles/datastore.user"
 *
 * Firestore vector index (run once, takes ~5 min):
 *   gcloud firestore indexes composite create \
 *     --collection-group=nutrition_vectors \
 *     --query-scope=COLLECTION \
 *     --field-config field-path=goalCategory,order=ASCENDING \
 *     --field-config field-path=embedding,vector-config='{"dimension":768,"flat": {}}' \
 *     --project <PROJECT>
 *
 * Staleness: chunks older than CHUNK_TTL_DAYS are refreshed on next request.
 */

const { Firestore, FieldValue, Filter } = require('@google-cloud/firestore');
const { GoogleGenAI } = require('@google/genai');

const COLLECTION      = 'nutrition_vectors';
const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIM   = 768;
const CHUNK_TTL_DAYS  = 7;
const TOP_K_DEFAULT   = 8;
const BATCH_SIZE      = 5;   // concurrent embed calls

// ── Clients ───────────────────────────────────────────────────────────────────

const firestore = new Firestore({
    projectId: process.env.GCP_PROJECT_ID || 'healthmonitor-493021',
    // On Cloud Run, ADC credentials are used automatically.
    // Locally, set GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
    // OR run: gcloud auth application-default login
});

const genAI = new GoogleGenAI({
    vertexai: true,
    project:  process.env.GCP_PROJECT_ID || 'healthmonitor-493021',
    location: process.env.GCP_LOCATION   || 'us-central1',
});

// ── Embedding helper ──────────────────────────────────────────────────────────

async function embed(text) {
    const truncated = text.slice(0, 2048);
    const res = await genAI.models.embedContent({
        model:    EMBEDDING_MODEL,
        contents: truncated,
    });
    const values = res?.embeddings?.[0]?.values;
    if (!values?.length) throw new Error('Empty embedding from Vertex AI');
    return values; // number[] of length 768
}

// ── Store operations ──────────────────────────────────────────────────────────

/**
 * Check whether fresh chunks exist for the given goal category.
 */
async function hasValidChunks(goalCategory) {
    const cutoff = new Date(Date.now() - CHUNK_TTL_DAYS * 86400000);
    // Single-field query only (no composite index required).
    // Fetch up to 10 docs and check if any were created within TTL window.
    const snap = await firestore.collection(COLLECTION)
        .where('goalCategory', '==', goalCategory)
        .limit(10)
        .get();
    if (snap.empty) return false;
    return snap.docs.some(doc => {
        const raw = doc.data().createdAt;
        const ts  = raw?.toDate?.() ?? new Date(raw);
        return ts > cutoff;
    });
}

/**
 * Delete all stored chunks for a category (before re-indexing).
 */
async function clearChunks(goalCategory) {
    const snap = await firestore.collection(COLLECTION)
        .where('goalCategory', '==', goalCategory)
        .get();
    if (snap.empty) return;
    const batch = firestore.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`[VectorStore] Cleared ${snap.size} chunks for "${goalCategory}"`);
}

/**
 * Embed and store an array of text chunks in Firestore.
 *
 * @param {string} goalCategory  e.g. 'running'
 * @param {Array<{topic: string, text: string, source: string}>} chunks
 */
async function storeChunks(goalCategory, chunks) {
    if (!chunks.length) return;
    await clearChunks(goalCategory);

    let stored = 0;
    const now  = new Date();

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (chunk) => {
            try {
                const values = await embed(`${chunk.topic}: ${chunk.text}`);
                await firestore.collection(COLLECTION).add({
                    goalCategory,
                    topicLabel:  chunk.topic,
                    contentText: chunk.text,
                    sourceTitle: chunk.source || '',
                    embedding:   FieldValue.vector(values),
                    createdAt:   now,
                });
                stored++;
            } catch (e) {
                console.warn(`[VectorStore] Embed failed for "${chunk.topic}":`, e.message.slice(0, 80));
            }
        }));
    }
    console.log(`[VectorStore] Stored ${stored}/${chunks.length} chunks for "${goalCategory}"`);
}

/**
 * Retrieve the top-K semantically closest chunks using Firestore's findNearest().
 *
 * NOTE: Requires a Firestore vector index on the `embedding` field.
 * See setup instructions at the top of this file.
 *
 * Falls back to client-side cosine similarity if the index isn't ready yet.
 *
 * @param {string} query        User's goal / question
 * @param {string} goalCategory Filter to this category
 * @param {number} topK         Chunks to return (default 8)
 * @returns {Promise<Array<{topic, text, source, score}>>}
 */
async function semanticSearch(query, goalCategory, topK = TOP_K_DEFAULT) {
    const queryVec = await embed(query);

    // ── Try Firestore native vector search first ─────────────────────────────
    try {
        const vectorQuery = firestore.collection(COLLECTION)
            .where('goalCategory', '==', goalCategory)
            .findNearest('embedding', FieldValue.vector(queryVec), {
                limit:           topK,
                distanceMeasure: 'COSINE',
            });

        const snap = await vectorQuery.get();
        if (!snap.empty) {
            const results = snap.docs.map(doc => {
                const d = doc.data();
                return { topic: d.topicLabel, text: d.contentText, source: d.sourceTitle, score: null };
            });
            console.log(`[VectorStore] Firestore findNearest → ${results.length} chunks for "${goalCategory}"`);
            return results;
        }
    } catch (indexErr) {
        console.warn('[VectorStore] findNearest unavailable (index not ready?), falling back to client-side:', indexErr.message.slice(0, 120));
    }

    // ── Fallback: client-side cosine similarity ──────────────────────────────
    const snap = await firestore.collection(COLLECTION)
        .where('goalCategory', '==', goalCategory)
        .get();

    if (snap.empty) return [];

    const scored = snap.docs.map(doc => {
        const d = doc.data();
        const chunkVec = d.embedding?.toArray?.() ?? [];
        if (!chunkVec.length) return null;
        const dot  = queryVec.reduce((s, v, i) => s + v * (chunkVec[i] || 0), 0);
        const magA = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
        const magB = Math.sqrt(chunkVec.reduce((s, v) => s + v * v, 0));
        return {
            topic:  d.topicLabel,
            text:   d.contentText,
            source: d.sourceTitle,
            score:  dot / (magA * magB + 1e-10),
        };
    }).filter(Boolean);

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, topK);
    console.log(`[VectorStore] Client-side search → top score: ${results[0]?.score?.toFixed(3)}, ${results.length} chunks`);
    return results;
}

/**
 * Format search results as a labelled markdown context string for injection.
 */
function chunksToContext(chunks) {
    if (!chunks.length) return '';
    const byTopic = {};
    for (const c of chunks) {
        if (!byTopic[c.topic]) byTopic[c.topic] = [];
        byTopic[c.topic].push(c.text);
    }
    return Object.entries(byTopic)
        .map(([topic, texts]) => `## ${topic}\n${texts.join('\n')}`)
        .join('\n\n');
}

module.exports = { storeChunks, semanticSearch, hasValidChunks, clearChunks, chunksToContext, embed };
