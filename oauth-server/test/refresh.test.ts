import { describe, expect, it } from 'vitest';
import type { TokenResponse } from '../src/oauth/model.js';
import { OTHER_CLIENT, createTestServer } from './support/test-server.js';

describe('POST /oauth/token — grant_type=refresh_token (Refresh Token Rotation)', () => {
  it('émet un nouvel access token et un nouveau refresh token', async () => {
    const { obtainTokens, refresh } = createTestServer();
    const first = await obtainTokens();
    const response = await refresh(first.refresh_token);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const second = response.body as TokenResponse;
    expect(second).toMatchObject({ token_type: 'Bearer', expires_in: 86400 });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
  });

  it('le nouvel access token fonctionne', async () => {
    const { obtainTokens, refresh, introspect } = createTestServer();
    const { access_token } = (await refresh((await obtainTokens()).refresh_token)).body as TokenResponse;
    expect((await introspect(access_token)).active).toBe(true);
  });

  it("invalide immédiatement l'ancien refresh token", async () => {
    const { obtainTokens, refresh } = createTestServer();
    const first = await obtainTokens();
    expect((await refresh(first.refresh_token)).status).toBe(200);

    const replay = await refresh(first.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: 'invalid_grant' });
  });

  it("invalide l'ancien access token", async () => {
    const { obtainTokens, refresh, introspect } = createTestServer();
    const first = await obtainTokens();
    expect((await introspect(first.access_token)).active).toBe(true);

    await refresh(first.refresh_token);
    expect((await introspect(first.access_token)).active).toBe(false);
  });

  it('rotation en chaîne A → B → C → D : seul le dernier refresh token est utilisable', async () => {
    const { obtainTokens, refresh, introspect } = createTestServer();
    const chain: TokenResponse[] = [await obtainTokens()];
    for (let i = 0; i < 3; i++) {
      const response = await refresh(chain.at(-1)?.refresh_token ?? '');
      expect(response.status).toBe(200);
      chain.push(response.body as TokenResponse);
    }

    expect(new Set(chain.map((t) => t.refresh_token)).size).toBe(4);
    for (const old of chain.slice(0, -1)) {
      expect((await refresh(old.refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
      expect((await introspect(old.access_token)).active).toBe(false);
    }
    const last = chain.at(-1) as TokenResponse;
    expect((await introspect(last.access_token)).active).toBe(true);
    expect((await refresh(last.refresh_token)).status).toBe(200);
  });

  it('deux refresh simultanés avec le même token : un seul réussit', async () => {
    const { obtainTokens, refresh } = createTestServer();
    const { refresh_token } = await obtainTokens();
    const responses = await Promise.all([
      refresh(refresh_token),
      refresh(refresh_token),
      refresh(refresh_token),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('conserve le contexte et les scopes à travers la rotation', async () => {
    const { obtainTokens, refresh, introspect } = createTestServer();
    const first = await obtainTokens({ context: 'firm:1', scope: 'customers:readonly suppliers:readonly' });
    const { access_token } = (await refresh(first.refresh_token)).body as TokenResponse;

    expect(await introspect(access_token)).toMatchObject({
      active: true,
      context: { type: 'firm', id: 1 },
      scope: 'customers:readonly suppliers:readonly',
    });
  });

  it('permet de rafraîchir un access token expiré', async () => {
    const { obtainTokens, refresh, introspect, clock } = createTestServer({ ACCESS_TOKEN_TTL: '10' });
    const first = await obtainTokens();
    clock.advanceBySeconds(10);
    expect((await introspect(first.access_token)).active).toBe(false);

    const response = await refresh(first.refresh_token);
    expect(response.status).toBe(200);
    expect((await introspect((response.body as TokenResponse).access_token)).active).toBe(true);
  });

  it('refuse un refresh token inconnu avec invalid_grant', async () => {
    const { refresh } = createTestServer();
    const response = await refresh('not-a-real-refresh-token');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuse un access token présenté comme refresh token', async () => {
    const { obtainTokens, refresh } = createTestServer();
    expect((await refresh((await obtainTokens()).access_token)).body).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('refuse un refresh token révoqué', async () => {
    const { obtainTokens, refresh, revoke } = createTestServer();
    const { refresh_token } = await obtainTokens();
    expect((await revoke(refresh_token)).status).toBe(200);
    expect((await refresh(refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuse un refresh token expiré (REFRESH_TOKEN_TTL, 90 jours par défaut)', async () => {
    const { obtainTokens, refresh, clock } = createTestServer();
    const { refresh_token } = await obtainTokens();
    clock.advanceBySeconds(90 * 86_400);
    expect((await refresh(refresh_token)).body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuse un refresh token émis pour un autre client, sans le consommer', async () => {
    const { obtainTokens, refresh } = createTestServer();
    const { refresh_token } = await obtainTokens();
    const response = await refresh(refresh_token, {
      client_id: OTHER_CLIENT.id,
      client_secret: OTHER_CLIENT.secret,
    });

    expect(response.body).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(refresh_token)).status).toBe(200);
  });

  it('refuse un mauvais client_secret avec invalid_client, sans consommer le refresh token', async () => {
    const { obtainTokens, refresh } = createTestServer();
    const { refresh_token } = await obtainTokens();

    const response = await refresh(refresh_token, { client_secret: 'wrong' });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_client' });
    expect((await refresh(refresh_token)).status).toBe(200);
  });

  it('refuse un refresh_token absent avec invalid_request', async () => {
    const { refresh } = createTestServer();
    expect((await refresh('')).body).toMatchObject({ error: 'invalid_request' });
  });
});
