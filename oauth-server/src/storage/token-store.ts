import type { AccessTokenRecord, RefreshTokenRecord, RevocationReason } from '../oauth/model.js';

export interface TokenStore {
  /** Enregistre une paire access + refresh token liés l'un à l'autre. */
  savePair(accessToken: AccessTokenRecord, refreshToken: RefreshTokenRecord): Promise<void>;
  findAccessToken(tokenHash: string): Promise<AccessTokenRecord | undefined>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  /**
   * Révoque, de façon atomique, un refresh token et l'access token qui lui est lié.
   * Renvoie false si le refresh token était déjà révoqué : c'est la garde de la rotation
   * (deux refresh simultanés avec le même token → un seul réussit).
   */
  revokePair(refreshTokenHash: string, reason: RevocationReason, revokedAt: number): Promise<boolean>;
}
