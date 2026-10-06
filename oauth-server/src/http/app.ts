import express, { type Express } from 'express';
import type { ApiRoute } from '../config/environment.js';
import type { Logger } from '../logger.js';
import type { AuthorizationService } from '../oauth/authorization-service.js';
import type { TokenService } from '../oauth/token-service.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { createApiProxyRouter } from './routes/api-proxy-router.js';
import { createIntrospectionRouter } from './routes/introspection-router.js';
import { createOAuthRouter } from './routes/oauth-router.js';

export interface AppDependencies {
  authorization: AuthorizationService;
  tokens: TokenService;
  logger: Logger;
  apiRoutes: ApiRoute[];
}

export function createApp({ authorization, tokens, logger, apiRoutes }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use(createOAuthRouter(authorization, tokens));
  app.use(createIntrospectionRouter(tokens));
  app.use(createApiProxyRouter(apiRoutes, logger));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
