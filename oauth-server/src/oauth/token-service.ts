// POST /oauth/token (authorization_code, refresh_token), POST /oauth/revoke,
// et vérification des access tokens pour l'API protégée.

import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import { generateOpaqueToken, hashToken } from '../security/opaque-token.js';
import type { AuthorizationCodeStore } from '../storage/authorization-code-store.js';
import type { ClientStore } from '../storage/client-store.js';
import type { TokenStore } from '../storage/token-store.js';
import { authenticateClient } from './client-authentication.js';
import type { AccessTokenRecord, Grant, OAuthClient, TokenResponse } from './model.js';
import { OAuthError } from './oauth-error.js';

export interface TokenRequestParams {
  client_id?: string | undefined;
  client_secret?: string | undefined;
  grant_type?: string | undefined;
  code?: string | undefined;
  redirect_uri?: string | undefined;
  refresh_token?: string | undefined;
}

export interface RevocationRequestParams {
  client_id?: string | undefined;
  client_secret?: string | undefined;
  token?: string | undefined;
}

export type AccessTokenVerification =
  { valid: true; token: AccessTokenRecord } | { valid: false; reason: 'invalid' | 'expired' | 'revoked' };

export interface TokenServiceDependencies {
  clients: ClientStore;
  authorizationCodes: AuthorizationCodeStore;
  tokens: TokenStore;
  clock: Clock;
  logger: Logger;
  /** Durées de vie, en secondes. */
  accessTokenTtl: number;
  refreshTokenTtl: number;
}

const copyGrant = ({ clientId, context, scopes, user }: Grant): Grant => ({
  clientId,
  context: { ...context },
  scopes: [...scopes],
  user: { ...user },
});

export class TokenService {
  constructor(private readonly deps: TokenServiceDependencies) {}

  async handleTokenRequest(params: TokenRequestParams): Promise<TokenResponse> {
    const client = await authenticateClient(this.deps.clients, params.client_id, params.client_secret);
    switch (params.grant_type) {
      case 'authorization_code':
        return this.exchangeAuthorizationCode(client, params.code, params.redirect_uri);
      case 'refresh_token':
        return this.rotateRefreshToken(client, params.refresh_token);
      case undefined:
      case '':
        throw new OAuthError('invalid_request');
      default:
        throw new OAuthError('unsupported_grant_type');
    }
  }

  /** RFC 7009 : un token inconnu, déjà révoqué ou appartenant à un autre client ne provoque pas d'erreur. */
  async revoke(params: RevocationRequestParams): Promise<void> {
    const client = await authenticateClient(this.deps.clients, params.client_id, params.client_secret);
    if (!params.token) throw new OAuthError('invalid_request');

    const tokenHash = hashToken(params.token);
    const accessToken = await this.deps.tokens.findAccessToken(tokenHash);
    const refreshTokenHash = accessToken ? accessToken.refreshTokenHash : tokenHash;
    const refreshToken = await this.deps.tokens.findRefreshToken(refreshTokenHash);
    if (refreshToken?.clientId !== client.id) return;

    // Révoquer l'un révoque l'autre : la paire access/refresh est un seul et même accès accordé.
    if (await this.deps.tokens.revokePair(refreshTokenHash, 'revoked', this.deps.clock.now())) {
      this.deps.logger.info(
        `token revoked: client=${client.id} kind=${accessToken ? 'access_token' : 'refresh_token'}`,
      );
    }
  }

  async verifyAccessToken(accessToken: string): Promise<AccessTokenVerification> {
    const token = await this.deps.tokens.findAccessToken(hashToken(accessToken));
    if (!token) return { valid: false, reason: 'invalid' };
    if (token.revokedAt !== undefined) return { valid: false, reason: 'revoked' };
    if (token.expiresAt <= this.deps.clock.now()) return { valid: false, reason: 'expired' };
    return { valid: true, token };
  }

  private async exchangeAuthorizationCode(
    client: OAuthClient,
    code: string | undefined,
    redirectUri: string | undefined,
  ): Promise<TokenResponse> {
    if (!code || !redirectUri) throw new OAuthError('invalid_request');
    const now = this.deps.clock.now();
    const record = await this.deps.authorizationCodes.findByHash(hashToken(code));
    const isValid =
      record !== undefined &&
      record.usedAt === undefined &&
      record.clientId === client.id &&
      record.redirectUri === redirectUri &&
      record.expiresAt > now;
    // markAsUsed est la garde atomique : de deux échanges simultanés, un seul obtient des tokens.
    if (!isValid || !(await this.deps.authorizationCodes.markAsUsed(record.codeHash, now))) {
      throw new OAuthError('invalid_grant');
    }
    this.deps.logger.info(`authorization code exchanged: client=${client.id}`);
    return this.issueTokenPair(copyGrant(record));
  }

  /**
   * Refresh Token Rotation : le refresh token présenté et son access token sont révoqués,
   * une nouvelle paire est émise. Rejouer l'ancien refresh token échoue (invalid_grant).
   */
  private async rotateRefreshToken(
    client: OAuthClient,
    refreshToken: string | undefined,
  ): Promise<TokenResponse> {
    if (!refreshToken) throw new OAuthError('invalid_request');
    const now = this.deps.clock.now();
    const record = await this.deps.tokens.findRefreshToken(hashToken(refreshToken));
    const isValid =
      record !== undefined &&
      record.revokedAt === undefined &&
      record.clientId === client.id &&
      record.expiresAt > now;
    if (!isValid || !(await this.deps.tokens.revokePair(record.tokenHash, 'rotated', now))) {
      throw new OAuthError('invalid_grant');
    }
    this.deps.logger.info(`refresh token rotated: client=${client.id}`);
    return this.issueTokenPair(copyGrant(record));
  }

  private async issueTokenPair(grant: Grant): Promise<TokenResponse> {
    const now = this.deps.clock.now();
    const accessToken = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);

    await this.deps.tokens.savePair(
      {
        ...grant,
        tokenHash: accessTokenHash,
        refreshTokenHash,
        expiresAt: now + this.deps.accessTokenTtl * 1000,
      },
      {
        ...grant,
        tokenHash: refreshTokenHash,
        accessTokenHash,
        expiresAt: now + this.deps.refreshTokenTtl * 1000,
      },
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.deps.accessTokenTtl,
      refresh_token: refreshToken,
    };
  }
}
