import { describe, expect, it } from 'vitest';
import { CLIENT, OTHER_CLIENT, createTestServer } from './support/test-server.js';

describe('POST /oauth/token — grant_type=authorization_code', () => {
  it('échange le code contre un access token et un refresh token au format Pennylane', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const response = await exchangeCode(await authorize());

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body as object).sort()).toEqual(
      ['access_token', 'expires_in', 'refresh_token', 'token_type'].sort(),
    );
    expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 86400 });
    const { access_token, refresh_token } = response.body as { access_token: string; refresh_token: string };
    expect(access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access_token).not.toBe(refresh_token);
  });

  it('expires_in reflète ACCESS_TOKEN_TTL', async () => {
    const { authorize, exchangeCode } = createTestServer({ ACCESS_TOKEN_TTL: '10' });
    expect((await exchangeCode(await authorize())).body).toMatchObject({ expires_in: 10 });
  });

  it.each([
    ['client_secret incorrect', { client_secret: 'wrong' }],
    ['client_secret absent', { client_secret: '' }],
    ['client_id inconnu', { client_id: 'unknown' }],
    ['secret d’un autre client', { client_secret: OTHER_CLIENT.secret }],
  ])('refuse avec invalid_client (401) : %s', async (_label, overrides) => {
    const { authorize, exchangeCode } = createTestServer();
    const response = await exchangeCode(await authorize(), overrides);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_client' });
    expect(JSON.stringify(response.body)).not.toContain(CLIENT.secret);
  });

  it("n'accepte pas l'authentification client par en-tête Basic (non documentée par Pennylane)", async () => {
    const { authorize, http } = createTestServer();
    const code = await authorize();
    const response = await http
      .post('/oauth/token')
      .auth(CLIENT.id, CLIENT.secret)
      .type('form')
      .send({ code, redirect_uri: CLIENT.redirectUri, grant_type: 'authorization_code' });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: 'invalid_client' });
  });

  it('refuse un code inconnu avec invalid_grant', async () => {
    const { exchangeCode } = createTestServer();
    const response = await exchangeCode('not-a-real-code');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuse un redirect_uri différent de celui de l’autorisation avec invalid_grant', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const response = await exchangeCode(await authorize(), { redirect_uri: 'http://localhost:8000/other' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuse un code émis pour un autre client', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const code = await authorize({ clientId: OTHER_CLIENT.id, redirectUri: OTHER_CLIENT.redirectUri });
    const response = await exchangeCode(code);

    expect(response.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('un code ne peut être utilisé qu’une seule fois', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const code = await authorize();

    expect((await exchangeCode(code)).status).toBe(200);
    const replay = await exchangeCode(code);
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('deux échanges simultanés du même code : un seul réussit', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const code = await authorize();
    const statuses = (await Promise.all([exchangeCode(code), exchangeCode(code), exchangeCode(code)])).map(
      (response) => response.status,
    );
    expect(statuses.sort()).toEqual([200, 400, 400]);
  });

  it('un code expire après AUTHORIZATION_CODE_TTL (60 s par défaut)', async () => {
    const { authorize, exchangeCode, clock } = createTestServer();
    const stillValid = await authorize();
    const expired = await authorize();

    clock.advanceBySeconds(59);
    expect((await exchangeCode(stillValid)).status).toBe(200);
    clock.advanceBySeconds(1);
    const response = await exchangeCode(expired);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_grant' });
  });

  it('une tentative avec un mauvais redirect_uri ne consomme pas le code', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const code = await authorize();
    await exchangeCode(code, { redirect_uri: 'http://localhost:8000/other' });
    expect((await exchangeCode(code)).status).toBe(200);
  });

  it.each([
    ['code', { code: '' }],
    ['redirect_uri', { redirect_uri: '' }],
  ])('refuse avec invalid_request si %s est absent', async (_label, overrides) => {
    const { authorize, exchangeCode } = createTestServer();
    const response = await exchangeCode(await authorize(), overrides);
    expect(response.body).toMatchObject({ error: 'invalid_request' });
  });
});

describe('POST /oauth/token — validation de la requête', () => {
  it('refuse un grant_type non supporté avec unsupported_grant_type', async () => {
    const { authorize, exchangeCode } = createTestServer();
    for (const grantType of ['password', 'client_credentials', 'implicit']) {
      const response = await exchangeCode(await authorize(), { grant_type: grantType });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'unsupported_grant_type' });
    }
  });

  it('refuse un grant_type absent avec invalid_request', async () => {
    const { authorize, exchangeCode } = createTestServer();
    const response = await exchangeCode(await authorize(), { grant_type: '' });
    expect(response.body).toMatchObject({ error: 'invalid_request' });
  });

  it('lit les paramètres en application/x-www-form-urlencoded uniquement', async () => {
    const { authorize, http } = createTestServer();
    const code = await authorize();
    const response = await http.post('/oauth/token').send({
      client_id: CLIENT.id,
      client_secret: CLIENT.secret,
      code,
      redirect_uri: CLIENT.redirectUri,
      grant_type: 'authorization_code',
    });
    expect(response.status).toBe(401);
  });
});
