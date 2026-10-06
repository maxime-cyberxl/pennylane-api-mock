import type { AuthorizationCodeRecord } from '../oauth/model.js';

export interface AuthorizationCodeStore {
  save(code: AuthorizationCodeRecord): Promise<void>;
  findByHash(codeHash: string): Promise<AuthorizationCodeRecord | undefined>;
  /**
   * Marque le code comme utilisé, de façon atomique.
   * Renvoie false s'il l'était déjà : c'est ce qui garantit l'usage unique,
   * même avec deux échanges simultanés (Redis : GETDEL / SET NX, SQL : UPDATE ... WHERE used_at IS NULL).
   */
  markAsUsed(codeHash: string, usedAt: number): Promise<boolean>;
}
