const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

let mcpClient = null;

async function getMcpClient() {
    if (mcpClient) return mcpClient;

    // Ensure token is valid before spawning the subprocess — the subprocess
    // gets the token baked into its env at spawn time and cannot refresh itself.
    const { tokens, ensureValidToken } = require('./stravaService');
    await ensureValidToken();

    const transport = new StdioClientTransport({
        command: path.join(__dirname, '../node_modules/.bin/strava-mcp-server'),
        args: [],
        env: {
            STRAVA_ACCESS_TOKEN:  tokens.ACCESS_TOKEN  || '',
            STRAVA_REFRESH_TOKEN: tokens.REFRESH_TOKEN || '',
            STRAVA_CLIENT_ID:     tokens.CLIENT_ID     || '',
            STRAVA_CLIENT_SECRET: tokens.CLIENT_SECRET || '',
        }
    });

    const client = new Client(
        { name: 'health-analyser', version: '1.0.0' },
        { capabilities: {} }
    );

    await client.connect(transport);
    mcpClient = client;
    console.log('✅ Strava MCP client connected');
    return mcpClient;
}

// Call this after a token refresh so the next chat spawns a fresh subprocess
function resetMcpClient() {
    if (mcpClient) {
        try { mcpClient.close(); } catch (_) {}
        mcpClient = null;
        console.log('🔄 Strava MCP client reset (token refreshed)');
    }
}

module.exports = { getMcpClient, resetMcpClient };
