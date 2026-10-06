import { describe, expect, it } from 'vitest';
import { OTHER_CLIENT, createTestServer } from './support/test-server.js';

describe('POST /oauth/revoke', () => {
  it('révoque un access token : 200, corps vide, token inutilisable', async () => {
    const { obtainTokens, revoke, introspect } = createTestServer();
    const { access_token } = await obtainTokens();
    const response = await revoke(access_token);

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
    expect(response.headers['content-length']).toBe('0');
    expect(await introspect(access_token)).toEqual({ active: false, reason: 'revoked' });
  });

  it('révoque un refresh token : 200, corps vide, refresh impossible', async () => {
    const { obtainTokens, revoke, refresh } = createTestServer();
    const { refresh_token } = await obtainTokens();
    const response = await revoke(refresh_token);

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
    expect((await refresh(refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it("révoquer l'access token révoque aussi son refresh token, et inversement", async () => {
    const { obtainTokens, revoke, refresh, introspect } = createTestServer();
    const viaAccess = await obtainTokens();
    await revoke(viaAccess.access_token);
    expect((await refresh(viaAccess.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });

    const viaRefresh = await obtainTokens();
    await revoke(viaRefresh.refresh_token);
    expect((await introspect(viaRefresh.access_token)).active).toBe(false);
  });

  it('ne touche pas aux autres connexions du même client', async () => {
    const { obtainTokens, revoke, introspect } = createTestServer();
    const revoked = await obtainTokens();
    const kept = await obtainTokens();
    await revoke(revoked.access_token);
    expect((await introspect(kept.access_token)).active).toBe(true);
  });

  it('répond 200 pour un token inconnu ou déjà révoqué (RFC 7009)', async () => {
    const { obtainTokens, revoke } = createTestServer();
    const { access_token } = await obtainTokens();
    expect((await revoke('unknown-token')).status).toBe(200);
    expect((await revoke(access_token)).status).toBe(200);
    expect((await revoke(access_token)).status).toBe(200);
  });

  it("ne révoque pas le token d'un autre client", async () => {
    const { obtainTokens, revoke, introspect } = createTestServer();
    const { access_token } = await obtainTokens();
    const response = await revoke(access_token, {
      client_id: OTHER_CLIENT.id,
      client_secret: OTHER_CLIENT.secret,
    });

    expect(response.status).toBe(200);
    expect((await introspect(access_token)).active).toBe(true);
  });

  it('refuse un mauvais client_secret avec invalid_client, sans révoquer', async () => {
    const { obtainTokens, revoke, introspect } = createTestServer();
    const { access_token } = await obtainTokens();
    const response = await revoke(access_token, { client_secret: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_client' });
    expect((await introspect(access_token)).active).toBe(true);
  });

  it('refuse un token absent avec invalid_request', async () => {
    const { revoke } = createTestServer();
    expect((await revoke('')).body).toMatchObject({ error: 'invalid_request' });
  });
});
