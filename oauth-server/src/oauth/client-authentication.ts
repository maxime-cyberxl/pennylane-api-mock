import { secretsMatch } from '../security/opaque-token.js';
import type { ClientStore } from '../storage/client-store.js';
import type { OAuthClient } from './model.js';
import { OAuthError } from './oauth-error.js';

/**
 * Authentifie un client par client_id + client_secret dans le corps de la requête,
 * seule méthode documentée par Pennylane (pas d'en-tête Authorization: Basic).
 */
export async function authenticateClient(
  clients: ClientStore,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthClient> {
  if (!clientId || !clientSecret) throw new OAuthError('invalid_client');
  const client = await clients.findById(clientId);
  if (!client || !secretsMatch(clientSecret, client.secret)) throw new OAuthError('invalid_client');
  return client;
}
