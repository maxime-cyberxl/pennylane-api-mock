import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/environment.js';
import { createContainer } from '../src/container.js';
import { silentLogger } from '../src/logger.js';
import { apiServerData } from './support/test-server.js';

describe('loadConfig', () => {
  it('fournit des valeurs par défaut conformes à Pennylane', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.ttl).toEqual({ authorizationCode: 60, accessToken: 86_400, refreshToken: 7_776_000 });
    expect(config.client).toEqual({
      id: 'pennylane-poc',
      secret: 'pennylane-poc-secret',
      redirectUris: ['http://localhost:8000/pennylane/callback'],
      allowedScopes: undefined,
    });
  });

  it("relaie les 3 API Pennylane vers l'api-server", () => {
    expect(loadConfig({}).apiRoutes).toEqual([
      { prefix: '/api/external/v2', target: 'http://127.0.0.1:4010' },
      { prefix: '/api/external/firm/v1', target: 'http://127.0.0.1:4011' },
      { prefix: '/api/firm/v3', target: 'http://127.0.0.1:4012' },
      { prefix: '/public', target: 'http://127.0.0.1:4010' },
      { prefix: '/rails', target: 'http://127.0.0.1:4010' },
    ]);
    expect(loadConfig({ API_SERVER_HOST: 'pennylane-mock' }).apiRoutes[0]?.target).toBe(
      'http://pennylane-mock:4010',
    );
  });

  it('lit le client, les scopes et les durées depuis l’environnement', () => {
    const config = loadConfig({
      OAUTH_CLIENT_ID: 'my-client',
      OAUTH_CLIENT_SECRET: 'my-secret',
      OAUTH_REDIRECT_URI: 'http://localhost:8000/a http://localhost:8000/b',
      OAUTH_ALLOWED_SCOPES: 'customers:readonly customers:all',
      ACCESS_TOKEN_TTL: '10',
    });
    expect(config.client).toEqual({
      id: 'my-client',
      secret: 'my-secret',
      redirectUris: ['http://localhost:8000/a', 'http://localhost:8000/b'],
      allowedScopes: ['customers:readonly', 'customers:all'],
    });
    expect(config.ttl.accessToken).toBe(10);
  });

  it.each(['0', '-5', 'abc', '1.5'])('refuse ACCESS_TOKEN_TTL=%s', (value) => {
    expect(() => loadConfig({ ACCESS_TOKEN_TTL: value })).toThrow(ConfigError);
  });

  it('refuse un redirect_uri qui n’est pas une URL', () => {
    expect(() => loadConfig({ OAUTH_REDIRECT_URI: 'not a url' })).toThrow(ConfigError);
  });

  it('refuse au démarrage un scope autorisé inconnu de Pennylane', () => {
    const config = loadConfig({ OAUTH_ALLOWED_SCOPES: 'customers:readonly company:read' });
    expect(() => createContainer(config, { apiServerData, logger: silentLogger })).toThrow(ConfigError);
  });
});
