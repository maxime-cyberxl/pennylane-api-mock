import { describe, expect, it } from 'vitest';
import { createTestServer } from './support/test-server.js';

describe('POST /_mock/introspect (utilisé par l’api-server)', () => {
  it('décrit un access token valide : client, scopes, contexte, utilisateur, expiration', async () => {
    const { obtainTokens, introspect, clock } = createTestServer();
    const { access_token } = await obtainTokens({
      context: 'company:101',
      scope: 'customers:readonly customer_invoices:readonly',
    });

    expect(await introspect(access_token)).toEqual({
      active: true,
      client_id: 'pennylane-poc',
      token_type: 'Bearer',
      scope: 'customers:readonly customer_invoices:readonly',
      exp: Math.floor(clock.now() / 1000) + 86_400,
      context: { type: 'company', id: 101 },
      user: {
        id: 11,
        first_name: 'Claire',
        last_name: 'Lefèvre',
        email: 'claire.lefevre@atelier-lumiere.example',
      },
    });
  });

  it('indique pourquoi un token est inactif : inconnu, expiré, révoqué', async () => {
    const { obtainTokens, introspect, revoke, clock } = createTestServer();
    expect(await introspect('unknown')).toEqual({ active: false, reason: 'invalid' });

    const revoked = await obtainTokens();
    await revoke(revoked.access_token);
    expect(await introspect(revoked.access_token)).toEqual({ active: false, reason: 'revoked' });

    const expired = await obtainTokens();
    clock.advanceBySeconds(86_400);
    expect(await introspect(expired.access_token)).toEqual({ active: false, reason: 'expired' });
  });

  it('un refresh token n’est pas un access token', async () => {
    const { obtainTokens, introspect } = createTestServer();
    expect((await introspect((await obtainTokens()).refresh_token)).active).toBe(false);
  });

  it('répond inactive sans token', async () => {
    const { http } = createTestServer();
    const response = await http.post('/_mock/introspect').type('form').send({});
    expect(response.body).toEqual({ active: false, reason: 'invalid' });
  });
});
