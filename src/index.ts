/**
 * Entrypoint: validates the environment and starts the app (see app.ts).
 */

import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

createApp(config).listen(config.port, '127.0.0.1', () => {
  console.log(`kt-mcp listening on 127.0.0.1:${config.port}`);
  console.log(`MCP endpoint (public): ${new URL('/mcp', config.publicUrl).href}`);
});
