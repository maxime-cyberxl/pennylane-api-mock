import type { OAuthClient } from '../../oauth/model.js';
import type { ClientStore } from '../client-store.js';

export class InMemoryClientStore implements ClientStore {
  private readonly clients: Map<string, OAuthClient>;

  constructor(clients: OAuthClient[]) {
    this.clients = new Map(clients.map((client) => [client.id, client]));
  }

  findById(clientId: string): Promise<OAuthClient | undefined> {
    return Promise.resolve(this.clients.get(clientId));
  }
}
