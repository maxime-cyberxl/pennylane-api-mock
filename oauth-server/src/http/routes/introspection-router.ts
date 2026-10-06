// POST /_mock/introspect : endpoint interne au mock (il n'existe pas chez Pennylane).
// L'api-server l'appelle pour savoir si un access token OAuth est valide, et avec quel contexte et quels scopes.
// Format inspiré de la RFC 7662 (token introspection).

import express, { Router } from 'express';
import type { TokenService } from '../../oauth/token-service.js';
import { readParams } from '../request-params.js';

export function createIntrospectionRouter(tokens: TokenService): Router {
  const router = Router();

  router.post('/_mock/introspect', express.urlencoded({ extended: false }), async (req, res) => {
    const { token } = readParams(req.body, ['token'] as const);
    const verification = token ? await tokens.verifyAccessToken(token) : undefined;
    res.set('Cache-Control', 'no-store');
    if (!verification?.valid) {
      res.json({ active: false, reason: verification?.reason ?? 'invalid' });
      return;
    }
    const { clientId, scopes, expiresAt, context, user } = verification.token;
    res.json({
      active: true,
      client_id: clientId,
      token_type: 'Bearer',
      scope: scopes.join(' '),
      exp: Math.floor(expiresAt / 1000),
      context,
      user,
    });
  });

  return router;
}
