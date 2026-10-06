import type { AuthorizationCodeRecord } from '../../oauth/model.js';
import type { AuthorizationCodeStore } from '../authorization-code-store.js';

export class InMemoryAuthorizationCodeStore implements AuthorizationCodeStore {
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  save(code: AuthorizationCodeRecord): Promise<void> {
    this.codes.set(code.codeHash, { ...code });
    return Promise.resolve();
  }

  findByHash(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    const code = this.codes.get(codeHash);
    return Promise.resolve(code && { ...code });
  }

  markAsUsed(codeHash: string, usedAt: number): Promise<boolean> {
    const code = this.codes.get(codeHash);
    if (!code || code.usedAt !== undefined) return Promise.resolve(false);
    code.usedAt = usedAt;
    return Promise.resolve(true);
  }
}
