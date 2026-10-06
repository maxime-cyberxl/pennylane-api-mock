// Composition des dépendances : c'est le seul endroit qui choisit l'implémentation du stockage.
// Pour passer à Redis ou PostgreSQL, il suffit d'y fournir d'autres implémentations des interfaces de src/storage.

import { systemClock, type Clock } from './clock.js';
import { ConfigError, type Config } from './config/environment.js';
import { createApp } from './http/app.js';
import { consoleLogger, type Logger } from './logger.js';
import { AuthorizationService } from './oauth/authorization-service.js';
import { loadApiServerData, type ApiServerData } from './api-server/api-server-data.js';
import { TokenService } from './oauth/token-service.js';
import type { AuthorizationCodeStore } from './storage/authorization-code-store.js';
import type { ClientStore } from './storage/client-store.js';
import { InMemoryAuthorizationCodeStore } from './storage/in-memory/in-memory-authorization-code-store.js';
import { InMemoryClientStore } from './storage/in-memory/in-memory-client-store.js';
import { InMemoryTokenStore } from './storage/in-memory/in-memory-token-store.js';
import type { TokenStore } from './storage/token-store.js';

export interface ContainerOverrides {
  clock?: Clock;
  logger?: Logger;
  clients?: ClientStore;
  authorizationCodes?: AuthorizationCodeStore;
  tokens?: TokenStore;
  apiServerData?: ApiServerData;
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}) {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? consoleLogger;
  const apiServerData = overrides.apiServerData ?? loadApiServerData(config.apiServerDir);
  const { supportedScopes } = apiServerData;

  // Par défaut, le client peut demander tous les scopes des specs Pennylane.
  const allowedScopes = config.client.allowedScopes ?? supportedScopes;
  const unknownScopes = allowedScopes.filter((scope) => !supportedScopes.includes(scope));
  if (unknownScopes.length > 0) {
    throw new ConfigError(
      `OAUTH_ALLOWED_SCOPES contient des scopes inconnus de Pennylane : ${unknownScopes.join(' ')}`,
    );
  }
  const clients = overrides.clients ?? new InMemoryClientStore([{ ...config.client, allowedScopes }]);
  const authorizationCodes = overrides.authorizationCodes ?? new InMemoryAuthorizationCodeStore();
  const tokenStore = overrides.tokens ?? new InMemoryTokenStore();

  const authorization = new AuthorizationService({
    clients,
    authorizationCodes,
    clock,
    logger,
    supportedScopes,
    authorizationCodeTtl: config.ttl.authorizationCode,
    availableContexts: apiServerData.contexts,
  });
  const tokens = new TokenService({
    clients,
    authorizationCodes,
    tokens: tokenStore,
    clock,
    logger,
    accessTokenTtl: config.ttl.accessToken,
    refreshTokenTtl: config.ttl.refreshToken,
  });
  const app = createApp({ authorization, tokens, logger, apiRoutes: config.apiRoutes });

  return { app, authorization, tokens, logger, allowedScopes };
}
