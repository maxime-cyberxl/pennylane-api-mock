import { describe, expect, it } from 'vitest';
import type { TokenResponse } from '../src/oauth/model.js';
import { secretsMatch } from '../src/security/opaque-token.js';
import { CLIENT, createTestServer } from './support/test-server.js';

describe('sécurité', () => {
  it('ne journalise jamais le client secret, les codes ni les tokens', async () => {
    const { submitConsent, exchangeCode, refresh, revoke, introspect, logger } = createTestServer();
    const location = await submitConsent('approve', { state: 'state-value' });
    const code = location.searchParams.get('code') ?? '';
    const first = (await exchangeCode(code)).body as TokenResponse;
    const second = (await refresh(first.refresh_token)).body as TokenResponse;
    await introspect(second.access_token);
    await revoke(second.access_token);

    const logs = logger.lines.join('\n');
    expect(logs).toContain('refresh token rotated');
    for (const secret of [
      CLIENT.secret,
      code,
      first.access_token,
      first.refresh_token,
      second.access_token,
      second.refresh_token,
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it('les erreurs ne divulguent pas la cause du refus', async () => {
    const { authorize, exchangeCode, clock } = createTestServer();
    const unknown = await exchangeCode('unknown');
    const wrongUri = await exchangeCode(await authorize(), { redirect_uri: 'http://localhost:8000/x' });
    const expiredCode = await authorize();
    clock.advanceBySeconds(61);
    const expired = await exchangeCode(expiredCode);

    expect(unknown.body).toEqual(wrongUri.body);
    expect(unknown.body).toEqual(expired.body);
  });

  it('la page de consentement interdit scripts et iframes', async () => {
    const { http, authorizeQuery } = createTestServer();
    const response = await http.get('/oauth/authorize').query(authorizeQuery());
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('compare les secrets correctement, quelle que soit leur longueur', () => {
    expect(secretsMatch('secret', 'secret')).toBe(true);
    expect(secretsMatch('secret', 'secreT')).toBe(false);
    expect(secretsMatch('secret', 'secret-longer')).toBe(false);
    expect(secretsMatch('', 'secret')).toBe(false);
  });
});

describe('journal des requêtes', () => {
  it('journalise le chemin, sans la query string', async () => {
    const { http, authorizeQuery, logger } = createTestServer();
    await http.get('/oauth/authorize').query(authorizeQuery({ state: 'secret-state' }));

    expect(logger.lines).toContainEqual(expect.stringMatching(/^GET \/oauth\/authorize 200 \d+ms$/));
    expect(logger.lines.join('\n')).not.toContain('secret-state');
  });
});
