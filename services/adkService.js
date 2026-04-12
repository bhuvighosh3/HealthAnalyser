/**
 * Google ADK service — shared utilities for building and running ADK agents.
 * All agents in this app use Vertex AI via GOOGLE_GENAI_USE_VERTEXAI env vars.
 */

const {
    LlmAgent,
    Runner,
    InMemorySessionService,
    isFinalResponse,
    FunctionTool,
    MCPToolset,
    GOOGLE_SEARCH,
} = require('@google/adk');

// ── Configure ADK for Vertex AI ─────────────────────────────────────────────
process.env.GOOGLE_GENAI_USE_VERTEXAI  = 'true';
process.env.GOOGLE_CLOUD_PROJECT       = process.env.GCP_PROJECT_ID  || 'healthmonitor-493021';
process.env.GOOGLE_CLOUD_LOCATION      = process.env.GCP_LOCATION    || 'us-central1';

const APP_NAME = 'athleteiq';
const MODEL    = 'gemini-2.5-flash';

/**
 * Run an ADK LlmAgent with a single user message.
 * Creates a fresh ephemeral session per call (stateless HTTP model).
 * Cleans up any provided toolsets after the run completes.
 *
 * @param {LlmAgent} agent
 * @param {string}   message
 * @param {Array}    toolsetsToClose  MCPToolset instances to close after run
 * @returns {Promise<string>}         Final text response
 */
async function runAgent(agent, message, toolsetsToClose = []) {
    const sessionService = new InMemorySessionService();
    const runner = new Runner({ agent, appName: APP_NAME, sessionService });
    const session = await sessionService.createSession({ appName: APP_NAME, userId: 'user' });

    let text = '';
    try {
        for await (const event of runner.runAsync({
            userId: 'user',
            sessionId: session.id,
            newMessage: { role: 'user', parts: [{ text: message }] },
        })) {
            if (isFinalResponse(event) && event.content?.parts) {
                text = event.content.parts.map(p => p.text || '').join('');
            }
        }
    } finally {
        for (const ts of toolsetsToClose) {
            try { await ts.close(); } catch (_) {}
        }
    }
    return text;
}

/**
 * Create an MCPToolset backed by a stdio subprocess.
 *
 * @param {string} command  Path to the MCP server binary
 * @param {object} env      Environment variables for the subprocess
 * @returns {MCPToolset}
 */
function createStdioMcpToolset(command, env = {}) {
    return new MCPToolset({
        type: 'StdioConnectionParams',
        serverParams: { command, args: [], env: { ...process.env, ...env } },
    });
}

module.exports = {
    runAgent,
    createStdioMcpToolset,
    LlmAgent,
    FunctionTool,
    MCPToolset,
    GOOGLE_SEARCH,
    MODEL,
    APP_NAME,
};
