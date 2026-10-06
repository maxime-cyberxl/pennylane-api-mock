import supertest from 'supertest';
import { expect } from 'vitest';
import type { Clock } from '../../src/clock.js';
import { loadConfig, type Config } from '../../src/config/environment.js';
import { createContainer } from '../../src/container.js';
import type { Logger } from '../../src/logger.js';
import { loadApiServerData } from '../../src/api-server/api-server-data.js';
import type { TokenResponse } from '../../src/oauth/model.js';
import { InMemoryClientStore } from '../../src/storage/in-memory/in-memory-client-store.js';

export const CLIENT = {
  id: 'pennylane-poc',
  secret: 'pennylane-poc-secret',
  redirectUri: 'http://localhost:8000/pennylane/callback',
};

/** Second client enregistré, pour vérifier qu'un code ou token ne sert qu'au client à qui il a été émis. */
export const OTHER_CLIENT = {
  id: 'other-app',
  secret: 'other-app-secret',
  redirectUri: 'http://localhost:9000/callback',
};

/** Données de l'api-server, lues une fois par fichier de test (db-company.json pèse 10 Mo). */
export const apiServerData = loadApiServerData();

export class FakeClock implements Clock {
  private current = Date.parse('2026-10-01T10:00:00Z');

  now(): number {
    return this.current;
  }

  advanceBySeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(message);
  }
  error(message: string): void {
    this.lines.push(message);
  }
}

export interface AuthorizeOptions {
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  context?: string;
}

export function createTestServer(env: Record<string, string> = {}, configOverrides: Partial<Config> = {}) {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const config = loadConfig({
    OAUTH_CLIENT_ID: CLIENT.id,
    OAUTH_CLIENT_SECRET: CLIENT.secret,
    OAUTH_REDIRECT_URI: CLIENT.redirectUri,
    OAUTH_ALLOWED_SCOPES: 'customers:readonly customers:all customer_invoices:readonly suppliers:readonly',
    ...env,
  });
  Object.assign(config, configOverrides);
  const clients = new InMemoryClientStore([
    { ...config.client, allowedScopes: config.client.allowedScopes ?? apiServerData.supportedScopes },
    {
      id: OTHER_CLIENT.id,
      secret: OTHER_CLIENT.secret,
      redirectUris: [OTHER_CLIENT.redirectUri],
      allowedScopes: apiServerData.supportedScopes,
    },
  ]);
  const { app } = createContainer(config, { clock, logger, clients, apiServerData });
  const http = supertest(app);

  const authorizeQuery = (options: AuthorizeOptions = {}) => ({
    client_id: options.clientId ?? CLIENT.id,
    redirect_uri: options.redirectUri ?? CLIENT.redirectUri,
    response_type: 'code',
    scope: options.scope ?? 'customers:readonly customer_invoices:readonly',
    ...(options.state !== undefined && { state: options.state }),
  });

  /** Simule la soumission de la page de consentement et renvoie l'URL de redirection. */
  const submitConsent = async (decision: 'approve' | 'deny', options: AuthorizeOptions = {}) => {
    const response = await http
      .post('/oauth/authorize')
      .type('form')
      .send({ ...authorizeQuery(options), decision, context: options.context ?? 'company:101' });
    expect(response.status).toBe(302);
    return new URL(response.headers.location as string);
  };

  const authorize = async (options: AuthorizeOptions = {}): Promise<string> => {
    const code = (await submitConsent('approve', options)).searchParams.get('code');
    expect(code).toBeTruthy();
    return code as string;
  };

  const exchangeCode = (code: string, overrides: Record<string, string> = {}) =>
    http
      .post('/oauth/token')
      .type('form')
      .send({
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
        code,
        redirect_uri: CLIENT.redirectUri,
        grant_type: 'authorization_code',
        ...overrides,
      });

  const refresh = (refreshToken: string, overrides: Record<string, string> = {}) =>
    http
      .post('/oauth/token')
      .type('form')
      .send({
        client_id: CLIENT.id,
        client_secret: CLIENT.secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        ...overrides,
      });

  const revoke = (token: string, overrides: Record<string, string> = {}) =>
    http
      .post('/oauth/revoke')
      .type('form')
      .send({ client_id: CLIENT.id, client_secret: CLIENT.secret, token, ...overrides });

  const obtainTokens = async (options: AuthorizeOptions = {}): Promise<TokenResponse> => {
    const response = await exchangeCode(await authorize(options));
    expect(response.status).toBe(200);
    return response.body as TokenResponse;
  };

  /** Réponse de l'introspection, telle que l'api-server la reçoit pour un token OAuth. */
  const introspect = async (accessToken: string) => {
    const response = await http.post('/_mock/introspect').type('form').send({ token: accessToken });
    expect(response.status).toBe(200);
    return response.body as Record<string, unknown> & { active: boolean };
  };

  return {
    http,
    clock,
    logger,
    authorizeQuery,
    submitConsent,
    authorize,
    exchangeCode,
    refresh,
    revoke,
    obtainTokens,
    introspect,
  };
}
