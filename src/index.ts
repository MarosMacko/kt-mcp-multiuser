/**
 * Entrypoint: validates the environment and starts the app (see app.ts).
 */

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { versionLabel } from './version.js';

const config = loadConfig();

createApp(config).listen(config.port, config.host, () => {
  console.log(`kt-mcp ${versionLabel()} listening on ${config.host}:${config.port}`);
  console.log(`MCP endpoint (public): ${new URL('/mcp', config.publicUrl).href}`);
  console.log(
    `Access: ${config.allowedUsersFile ? `only e-mails in ${config.allowedUsersFile}` : 'anyone with a kaloricketabulky.sk/.cz account'}; ` +
      `local clients ${config.localClients ? 'allowed' : 'not allowed'}`,
  );
  if (!config.operator.contact) {
    console.warn('OPERATOR_CONTACT is not set: the privacy page (/privacy) shows no way to reach you.');
  }
});
