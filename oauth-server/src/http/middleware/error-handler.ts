import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../../logger.js';
import { OAuthError } from '../../oauth/oauth-error.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ status: 404, error: 'Not found' });
};

const isClientError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number' &&
  error.status >= 400 &&
  error.status < 500;

export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (error: unknown, _req, res, _next) => {
    if (error instanceof OAuthError) {
      res.status(error.status).set('Cache-Control', 'no-store').json(error);
      return;
    }
    if (isClientError(error)) {
      // Corps illisible (JSON/form mal formé...) : erreur OAuth générique.
      res.status(400).json(new OAuthError('invalid_request'));
      return;
    }
    logger.error(error instanceof Error ? (error.stack ?? error.message) : 'unknown error');
    res.status(500).json({ error: 'server_error' });
  };
