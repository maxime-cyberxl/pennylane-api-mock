import type { RequestHandler } from 'express';
import type { Logger } from '../../logger.js';

/** Journalise méthode, chemin (sans query string) et statut : jamais de paramètre ni de corps. */
export const requestLogger =
  (logger: Logger): RequestHandler =>
  (req, res, next) => {
    const startedAt = performance.now();
    const path = req.originalUrl.split('?')[0] ?? '';
    res.on('finish', () => {
      const duration = Math.round(performance.now() - startedAt);
      logger.info(`${req.method} ${path} ${res.statusCode} ${duration}ms`);
    });
    next();
  };
