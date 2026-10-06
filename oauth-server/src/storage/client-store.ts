import type { OAuthClient } from '../oauth/model.js';

export interface ClientStore {
  findById(clientId: string): Promise<OAuthClient | undefined>;
}
