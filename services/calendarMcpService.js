const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

let calendarClient = null;

async function getCalendarMcpClient() {
    if (calendarClient) return calendarClient;

    const credPath = process.env.GOOGLE_OAUTH_CREDENTIALS;
    if (!credPath) {
        throw new Error(
            'Google Calendar not configured. ' +
            'Set GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json in .env, ' +
            'then run: npx @cocal/google-calendar-mcp auth'
        );
    }

    const transport = new StdioClientTransport({
        command: path.join(__dirname, '../node_modules/.bin/google-calendar-mcp'),
        args: [],
        env: {
            ...process.env,
            GOOGLE_OAUTH_CREDENTIALS: credPath,
        }
    });

    const client = new Client(
        { name: 'health-analyser-calendar', version: '1.0.0' },
        { capabilities: {} }
    );

    await client.connect(transport);
    calendarClient = client;
    console.log('✅ Google Calendar MCP client connected');
    return calendarClient;
}

function resetCalendarMcpClient() {
    if (calendarClient) {
        try { calendarClient.close(); } catch (_) {}
        calendarClient = null;
        console.log('🔄 Calendar MCP client reset');
    }
}

function isCalendarConfigured() {
    return !!process.env.GOOGLE_OAUTH_CREDENTIALS;
}

module.exports = { getCalendarMcpClient, resetCalendarMcpClient, isCalendarConfigured };
