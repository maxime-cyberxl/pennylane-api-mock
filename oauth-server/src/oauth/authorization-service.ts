// GET/POST /oauth/authorize : validation de la demande, consentement, émission du code.

import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import { generateOpaqueToken, hashToken } from '../security/opaque-token.js';
import type { AuthorizationCodeStore } from '../storage/authorization-code-store.js';
import type { ClientStore } from '../storage/client-store.js';
import type { ConsentContext, OAuthClient, TokenContext } from './model.js';
import { OAuthError, type OAuthErrorCode } from './oauth-error.js';
import { parseScopeParameter } from './scopes.js';

export interface AuthorizationRequestParams {
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  response_type?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
}

export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  scopes: string[];
  state?: string;
}

/**
 * Erreur de /oauth/authorize. Tant que le client et le redirect_uri ne sont pas validés,
 * on ne doit pas rediriger (RFC 6749 §4.1.2.1) : `redirectUri` est alors absent et l'erreur est affichée.
 */
export class AuthorizationRequestError extends OAuthError {
  constructor(
    code: OAuthErrorCode,
    readonly redirectUri?: string,
    readonly state?: string,
  ) {
    super(code);
  }
}

/** Ajoute des paramètres au redirect_uri en conservant sa query string éventuelle. */
export function buildRedirectUrl(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

export interface AuthorizationServiceDependencies {
  clients: ClientStore;
  authorizationCodes: AuthorizationCodeStore;
  clock: Clock;
  logger: Logger;
  supportedScopes: string[];
  authorizationCodeTtl: number;
  availableContexts: ConsentContext[];
}

export class AuthorizationService {
  constructor(private readonly deps: AuthorizationServiceDependencies) {}

  get availableContexts(): ConsentContext[] {
    return this.deps.availableContexts;
  }

  async validate(params: AuthorizationRequestParams): Promise<AuthorizationRequest> {
    if (!params.client_id || !params.redirect_uri) throw new AuthorizationRequestError('invalid_request');
    const client = await this.deps.clients.findById(params.client_id);
    if (!client) throw new AuthorizationRequestError('invalid_client');
    if (!client.redirectUris.includes(params.redirect_uri))
      throw new AuthorizationRequestError('invalid_request');

    // À partir d'ici, le redirect_uri est sûr : les erreurs sont renvoyées au client par redirection.
    const redirectUri = params.redirect_uri;
    const state = params.state || undefined;
    const fail = (code: OAuthErrorCode) => new AuthorizationRequestError(code, redirectUri, state);

    if (!params.response_type) throw fail('invalid_request');
    if (params.response_type !== 'code') throw fail('unsupported_response_type');
    if (!params.scope) throw fail('invalid_request');
    const scopes = parseScopeParameter(params.scope);
    const allowed = scopes.every(
      (scope) => this.deps.supportedScopes.includes(scope) && client.allowedScopes.includes(scope),
    );
    if (scopes.length === 0 || !allowed) throw fail('invalid_scope');

    return { client, redirectUri, scopes, ...(state !== undefined && { state }) };
  }

  /**
   * Consentement accordé : émet un code à usage unique et renvoie l'URL de retour vers le client.
   * L'utilisateur qui accorde l'accès est celui du contexte choisi.
   */
  async approve(request: AuthorizationRequest, selected: TokenContext): Promise<string> {
    const consentContext = this.deps.availableContexts.find(
      (c) => c.type === selected.type && c.id === selected.id,
    );
    if (!consentContext)
      throw new AuthorizationRequestError('invalid_request', request.redirectUri, request.state);
    const context: TokenContext = { type: consentContext.type, id: consentContext.id };

    const code = generateOpaqueToken();
    await this.deps.authorizationCodes.save({
      codeHash: hashToken(code),
      clientId: request.client.id,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      context,
      user: { ...consentContext.user },
      expiresAt: this.deps.clock.now() + this.deps.authorizationCodeTtl * 1000,
    });
    this.deps.logger.info(
      `authorization granted: client=${request.client.id} context=${context.type}:${context.id} scopes="${request.scopes.join(' ')}"`,
    );
    return buildRedirectUrl(request.redirectUri, { code, state: request.state });
  }

  /** Consentement refusé : erreur OAuth standard access_denied, avec le state. */
  deny(request: AuthorizationRequest): string {
    this.deps.logger.info(`authorization denied: client=${request.client.id}`);
    return buildRedirectUrl(request.redirectUri, { error: 'access_denied', state: request.state });
  }
}
