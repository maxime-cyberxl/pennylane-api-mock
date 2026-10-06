// Configuration lue depuis les variables d'environnement, validée au démarrage.
// Les valeurs par défaut permettent de lancer le mock sans aucun fichier .env.

export interface OAuthClientConfig {
  id: string;
  secret: string;
  redirectUris: string[];
  /** Scopes que le client peut demander. Absent : tous les scopes des specs Pennylane. */
  allowedScopes: string[] | undefined;
}

/** Une API de l'api-server, relayée par ce serveur sous son préfixe Pennylane. */
export interface ApiRoute {
  prefix: string;
  target: string;
}

export interface Config {
  host: string;
  port: number;
  client: OAuthClientConfig;
  /** Durées de vie, en secondes. */
  ttl: {
    authorizationCode: number;
    accessToken: number;
    refreshToken: number;
  };
  /** Dossier de l'api-server : contextes du consentement (fixtures) et scopes (specs). */
  apiServerDir: string | undefined;
  /** Les 3 API Pennylane, relayées vers l'api-server : tout est servi sous une seule base URL. */
  apiRoutes: ApiRoute[];
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

const list = (value: string | undefined): string[] | undefined => {
  const items = value?.split(/[\s,]+/).filter(Boolean) ?? [];
  return items.length > 0 ? items : undefined;
};

const positiveInt = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} doit être un entier positif`);
  return value;
};

const assertUrl = (name: string, value: string): void => {
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`${name} contient une URL invalide : ${value}`);
  }
};

export function loadConfig(env: Env = process.env): Config {
  const client: OAuthClientConfig = {
    id: env.OAUTH_CLIENT_ID || 'pennylane-poc',
    secret: env.OAUTH_CLIENT_SECRET || 'pennylane-poc-secret',
    redirectUris: list(env.OAUTH_REDIRECT_URI) ?? ['http://localhost:8000/pennylane/callback'],
    allowedScopes: list(env.OAUTH_ALLOWED_SCOPES),
  };
  client.redirectUris.forEach((uri) => {
    assertUrl('OAUTH_REDIRECT_URI', uri);
  });

  // Ports de l'api-server (npm start ou conteneur pennylane-mock)
  const apiServerHost = env.API_SERVER_HOST || '127.0.0.1';
  const apiRoutes: ApiRoute[] = [
    { prefix: '/api/external/v2', target: `http://${apiServerHost}:4010` },
    { prefix: '/api/external/firm/v1', target: `http://${apiServerHost}:4011` },
    { prefix: '/api/firm/v3', target: `http://${apiServerHost}:4012` },
    // Fichiers des factures (public_file_url, file_url) : servis à l'identique par les 3 ports
    { prefix: '/public', target: `http://${apiServerHost}:4010` },
    { prefix: '/rails', target: `http://${apiServerHost}:4010` },
  ];

  return {
    host: env.OAUTH_HOST || '0.0.0.0',
    port: positiveInt(env, 'OAUTH_PORT', 3000),
    client,
    ttl: {
      authorizationCode: positiveInt(env, 'AUTHORIZATION_CODE_TTL', 60),
      accessToken: positiveInt(env, 'ACCESS_TOKEN_TTL', 86_400),
      refreshToken: positiveInt(env, 'REFRESH_TOKEN_TTL', 90 * 86_400),
    },
    apiServerDir: env.API_SERVER_DIR || undefined,
    apiRoutes,
  };
}
