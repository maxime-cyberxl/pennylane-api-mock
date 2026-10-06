import { ConfigError, loadConfig } from './config/environment.js';
import { createContainer } from './container.js';
import { ApiServerDataError } from './api-server/api-server-data.js';

function main(): void {
  const config = loadConfig();
  const { app, logger, authorization, allowedScopes } = createContainer(config);

  const server = app.listen(config.port, config.host, () => {
    const { client, ttl } = config;
    logger.info(`Pennylane OAuth mock listening on http://${config.host}:${config.port}`);
    // Le client secret n'est jamais journalisé.
    logger.info(`client_id=${client.id} redirect_uri=${client.redirectUris.join(' ')}`);
    logger.info(`allowed scopes: ${allowedScopes.length} scopes Pennylane`);
    const contexts = authorization.availableContexts.map((c) => `${c.type}:${c.id}`).join(' ');
    logger.info(`contexts (fixtures api-server): ${contexts}`);
    logger.info(`API relayées : ${config.apiRoutes.map((r) => `${r.prefix} → ${r.target}`).join(', ')}`);
    logger.info(
      `TTL (s): authorization_code=${ttl.authorizationCode} access_token=${ttl.accessToken} refresh_token=${ttl.refreshToken}`,
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

try {
  main();
} catch (error) {
  if (!(error instanceof ConfigError || error instanceof ApiServerDataError)) throw error;
  console.error(`Configuration invalide : ${error.message}`);
  process.exit(1);
}
