// Modèle du domaine OAuth. Les codes et tokens sont des chaînes opaques côté client :
// tout ce qu'ils « contiennent » (client, contexte, scopes) vit ici, côté serveur.

export interface OAuthClient {
  id: string;
  secret: string;
  /** Comparaison exacte, comme chez Pennylane : l'URI doit être déclarée à l'avance. */
  redirectUris: string[];
  allowedScopes: string[];
}

export type ContextType = 'company' | 'firm';

/** Company token : une seule entreprise. Firm token : les entreprises du cabinet. */
export interface TokenContext {
  type: ContextType;
  /** Identifiant Pennylane de l'entreprise ou du cabinet. */
  id: number;
}

/** Utilisateur Pennylane qui a accordé l'accès sur la page de consentement. */
export interface ResourceOwner {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

/** Contexte proposé sur la page de consentement, avec l'utilisateur qui s'y connecte. */
export interface ConsentContext extends TokenContext {
  name: string;
  user: ResourceOwner;
}

/** Ce qui a été accordé par l'utilisateur, et qui suit le code puis chaque paire de tokens. */
export interface Grant {
  clientId: string;
  context: TokenContext;
  scopes: string[];
  user: ResourceOwner;
}

export interface AuthorizationCodeRecord extends Grant {
  codeHash: string;
  redirectUri: string;
  expiresAt: number;
  usedAt?: number;
}

export type RevocationReason = 'revoked' | 'rotated';

interface TokenRecord extends Grant {
  tokenHash: string;
  expiresAt: number;
  revokedAt?: number;
  revocationReason?: RevocationReason;
}

export interface AccessTokenRecord extends TokenRecord {
  refreshTokenHash: string;
}

export interface RefreshTokenRecord extends TokenRecord {
  accessTokenHash: string;
}

/** Réponse de POST /oauth/token, strictement au format documenté par Pennylane. */
export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}
