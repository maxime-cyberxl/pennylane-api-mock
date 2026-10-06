import { describe, expect, it } from 'vitest';
import { CLIENT, OTHER_CLIENT, createTestServer } from './support/test-server.js';

describe('GET /oauth/authorize', () => {
  it('affiche la page de consentement pour un client valide', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http.get('/oauth/authorize').query(authorizeQuery({ state: 'abc123' }));

    expect(response.status).toBe(200);
    expect(response.type).toBe('text/html');
    expect(response.text).toContain(CLIENT.id);
    expect(response.text).toContain(CLIENT.redirectUri);
    expect(response.text).toContain('customers:readonly');
    // Contextes, noms et utilisateurs issus des fixtures de l'api-server
    expect(response.text).toContain('value="company:101"');
    expect(response.text).toContain('Atelier Lumière');
    expect(response.text).toContain('claire.lefevre@atelier-lumiere.example');
    expect(response.text).toContain('value="firm:1"');
    expect(response.text).toContain('Cabinet Delmas &amp; Associés');
    expect(response.text).toContain('helene.delmas@delmas-associes.example');
    expect(response.text).toContain('Autoriser');
    expect(response.text).toContain('Refuser');
    expect(response.text).not.toContain(CLIENT.secret);
  });

  it('échappe les valeurs affichées', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http
      .get('/oauth/authorize')
      .query(authorizeQuery({ state: '"><script>alert(1)</script>' }));

    expect(response.text).not.toContain('<script>');
    expect(response.text).toContain('&lt;script&gt;');
  });

  it('refuse un client inconnu sans rediriger', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http.get('/oauth/authorize').query(authorizeQuery({ clientId: 'unknown' }));

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.text).toContain('invalid_client');
  });

  it('refuse un redirect_uri différent de celui enregistré, sans rediriger', async () => {
    const { http, authorizeQuery } = createTestServer();
    for (const redirectUri of [
      'http://evil.example/callback',
      `${CLIENT.redirectUri}/other`,
      `${CLIENT.redirectUri}?x=1`,
      OTHER_CLIENT.redirectUri,
    ]) {
      const response = await http.get('/oauth/authorize').query(authorizeQuery({ redirectUri }));
      expect(response.status).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it('redirige avec unsupported_response_type si response_type ≠ code', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http
      .get('/oauth/authorize')
      .query({ ...authorizeQuery({ state: 's' }), response_type: 'token' });

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('s');
  });

  it('redirige avec invalid_request si le scope est absent', async () => {
    const { http, authorizeQuery } = createTestServer();
    const { scope: _scope, ...query } = authorizeQuery();
    const response = await http.get('/oauth/authorize').query(query);

    expect(new URL(response.headers.location as string).searchParams.get('error')).toBe('invalid_request');
  });

  it.each([
    ['inconnu', 'customers:readonly unknown:scope'],
    ['non autorisé pour ce client', 'customers:readonly customer_invoices:all'],
    ['séparé par des virgules', 'customers:readonly,customer_invoices:readonly'],
  ])('redirige avec invalid_scope pour un scope %s', async (_label, scope) => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http.get('/oauth/authorize').query(authorizeQuery({ scope, state: 'xyz' }));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe(CLIENT.redirectUri);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('refuse un paramètre répété', async () => {
    const { http } = createTestServer();
    const response = await http.get(
      `/oauth/authorize?client_id=${CLIENT.id}&client_id=${CLIENT.id}&redirect_uri=${encodeURIComponent(CLIENT.redirectUri)}&response_type=code&scope=customers:readonly`,
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /oauth/authorize (consentement)', () => {
  it("redirige vers redirect_uri avec un code et le state quand l'utilisateur autorise", async () => {
    const { submitConsent } = createTestServer();
    const location = await submitConsent('approve', { state: 'abc123' });

    expect(location.origin + location.pathname).toBe(CLIENT.redirectUri);
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toBe('abc123');
  });

  it('retourne le state exactement, caractères spéciaux compris', async () => {
    const { submitConsent } = createTestServer();
    const state = 'a b&c=d/é+%20';
    expect((await submitConsent('approve', { state })).searchParams.get('state')).toBe(state);
  });

  it("n'ajoute pas de state s'il n'a pas été fourni", async () => {
    const { submitConsent } = createTestServer();
    expect((await submitConsent('approve')).searchParams.has('state')).toBe(false);
  });

  it("redirige avec error=access_denied et le state quand l'utilisateur refuse", async () => {
    const { submitConsent } = createTestServer();
    const location = await submitConsent('deny', { state: 'abc123' });

    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('abc123');
    expect(location.searchParams.has('code')).toBe(false);
  });

  it('génère un code différent à chaque autorisation', async () => {
    const { authorize } = createTestServer();
    const codes = await Promise.all([authorize(), authorize(), authorize()]);
    expect(new Set(codes).size).toBe(3);
  });

  it('revalide la demande à la soumission (champs cachés falsifiés)', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http
      .post('/oauth/authorize')
      .type('form')
      .send({
        ...authorizeQuery({ redirectUri: 'http://evil.example/cb' }),
        decision: 'approve',
        context: 'company:101',
      });

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it('refuse un contexte qui ne fait pas partie de ceux proposés', async () => {
    const { submitConsent } = createTestServer();
    const location = await submitConsent('approve', { context: 'company:105' });
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });
});
