#!/usr/bin/env node
// Patches @r-huijts/strava-mcp-server to accept optional weight field.
// Strava doesn't always return weight in the athlete profile — the package's
// Zod schema uses .nullable() which rejects undefined. We patch to .optional().nullable().
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../node_modules/@r-huijts/strava-mcp-server/dist/stravaClient.js');

if (!fs.existsSync(target)) {
    console.log('[postinstall] strava-mcp-server not found, skipping patch.');
    process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');
const before = 'weight: z.number().nullable(),';
const after  = 'weight: z.number().optional().nullable(),';

if (src.includes(after)) {
    console.log('[postinstall] strava-mcp-server weight patch already applied.');
} else if (src.includes(before)) {
    fs.writeFileSync(target, src.replace(before, after));
    console.log('[postinstall] ✅ strava-mcp-server weight patch applied.');
} else {
    console.log('[postinstall] strava-mcp-server weight field not found — skipping.');
}
