import type { AccessTokenRecord, RefreshTokenRecord, RevocationReason } from '../../oauth/model.js';
import type { TokenStore } from '../token-store.js';

export class InMemoryTokenStore implements TokenStore {
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  savePair(accessToken: AccessTokenRecord, refreshToken: RefreshTokenRecord): Promise<void> {
    this.accessTokens.set(accessToken.tokenHash, { ...accessToken });
    this.refreshTokens.set(refreshToken.tokenHash, { ...refreshToken });
    return Promise.resolve();
  }

  findAccessToken(tokenHash: string): Promise<AccessTokenRecord | undefined> {
    const token = this.accessTokens.get(tokenHash);
    return Promise.resolve(token && { ...token });
  }

  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const token = this.refreshTokens.get(tokenHash);
    return Promise.resolve(token && { ...token });
  }

  revokePair(refreshTokenHash: string, reason: RevocationReason, revokedAt: number): Promise<boolean> {
    const refreshToken = this.refreshTokens.get(refreshTokenHash);
    if (!refreshToken || refreshToken.revokedAt !== undefined) return Promise.resolve(false);
    const accessToken = this.accessTokens.get(refreshToken.accessTokenHash);
    for (const token of [refreshToken, accessToken]) {
      if (token && token.revokedAt === undefined) {
        token.revokedAt = revokedAt;
        token.revocationReason = reason;
      }
    }
    return Promise.resolve(true);
  }
}
