// Endpoints OAuth, au contrat Pennylane : /oauth/authorize, /oauth/token, /oauth/revoke.
// Les paramètres de /oauth/token et /oauth/revoke sont lus en application/x-www-form-urlencoded.

import express, { Router, type Response } from 'express';
import {
  AuthorizationRequestError,
  buildRedirectUrl,
  type AuthorizationService,
} from '../../oauth/authorization-service.js';
import { OAuthError } from '../../oauth/oauth-error.js';
import type { TokenService } from '../../oauth/token-service.js';
import { readParams } from '../request-params.js';
import { decodeContext, renderConsentPage } from '../views/consent-page.js';
import { renderErrorPage } from '../views/error-page.js';
import { PAGE_SECURITY_HEADERS } from '../views/html.js';

const AUTHORIZE_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'] as const;
const CONSENT_PARAMS = [...AUTHORIZE_PARAMS, 'decision', 'context'] as const;
const TOKEN_PARAMS = [
  'client_id',
  'client_secret',
  'grant_type',
  'code',
  'redirect_uri',
  'refresh_token',
] as const;
const REVOKE_PARAMS = ['client_id', 'client_secret', 'token'] as const;

/** Une erreur d'autorisation est renvoyée au client par redirection quand c'est sûr, affichée sinon. */
async function respondToAuthorization(res: Response, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof AuthorizationRequestError && error.redirectUri !== undefined) {
      res.redirect(buildRedirectUrl(error.redirectUri, { error: error.code, state: error.state }));
    } else if (error instanceof OAuthError) {
      res.status(400).set(PAGE_SECURITY_HEADERS).type('html').send(renderErrorPage(error));
    } else {
      throw error;
    }
  }
}

export function createOAuthRouter(authorization: AuthorizationService, tokens: TokenService): Router {
  const router = Router();
  router.use('/oauth', express.urlencoded({ extended: false }));

  router.get('/oauth/authorize', async (req, res) => {
    await respondToAuthorization(res, async () => {
      const request = await authorization.validate(readParams(req.query, AUTHORIZE_PARAMS));
      res
        .set(PAGE_SECURITY_HEADERS)
        .type('html')
        .send(renderConsentPage(request, authorization.availableContexts));
    });
  });

  // Soumission de la page de consentement : la demande est entièrement revalidée.
  router.post('/oauth/authorize', async (req, res) => {
    await respondToAuthorization(res, async () => {
      const params = readParams(req.body, CONSENT_PARAMS);
      const request = await authorization.validate(params);
      if (params.decision === 'deny') {
        res.redirect(authorization.deny(request));
        return;
      }
      const context = decodeContext(params.context);
      if (params.decision !== 'approve' || !context) {
        throw new AuthorizationRequestError('invalid_request', request.redirectUri, request.state);
      }
      res.redirect(await authorization.approve(request, context));
    });
  });

  router.post('/oauth/token', async (req, res) => {
    const response = await tokens.handleTokenRequest(readParams(req.body, TOKEN_PARAMS));
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(response);
  });

  // Pennylane : 200 avec un corps vide.
  router.post('/oauth/revoke', async (req, res) => {
    await tokens.revoke(readParams(req.body, REVOKE_PARAMS));
    res.status(200).end();
  });

  return router;
}
