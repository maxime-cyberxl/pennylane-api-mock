// Vérifie le flow complet contre les deux mocks réellement lancés (docker compose up) :
// authorize → code → token → API (via le point d'entrée unique) → expiration → refresh → rotation
// → ancien refresh rejeté → revoke ; plus scopes, firm token et jetons statiques.
//
//   npm run verify:e2e -w oauth-server        (BASE_URL=http://localhost:3000 par défaut)
//
// Pour tester l'expiration sans attendre 24 h, lancer les mocks avec ACCESS_TOKEN_TTL=5.

import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_SERVER_URL = process.env.API_SERVER_URL ?? 'http://localhost:4010';
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'pennylane-poc';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? 'pennylane-poc-secret';
const REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI?.split(' ')[0] ?? 'http://localhost:8000/pennylane/callback';
const MAX_WAIT_FOR_EXPIRATION = 30;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

const step = (label: string) => {
  console.log(`✓ ${label}`);
};

const form = (path: string, params: Record<string, string>) =>
  fetch(`${BASE_URL}${path}`, { method: 'POST', body: new URLSearchParams(params), redirect: 'manual' });

const api = (path: string, accessToken: string, headers: Record<string, string> = {}, base = BASE_URL) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, ...headers } });

const tokenRequest = async (params: Record<string, string>) => {
  const response = await form('/oauth/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...params,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const refresh = (refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

const asTokens = (body: Record<string, unknown>): TokenResponse => {
  assert.deepEqual(Object.keys(body).sort(), ['access_token', 'expires_in', 'refresh_token', 'token_type']);
  assert.equal(body.token_type, 'Bearer');
  return body as unknown as TokenResponse;
};

/** Parcours complet : page de consentement → clic « Autoriser » → échange du code. */
async function connect(context: string, scope: string): Promise<TokenResponse> {
  const state = `state-${Date.now()}`;
  const params = { client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope, state };
  const page = await fetch(`${BASE_URL}/oauth/authorize?${new URLSearchParams(params).toString()}`);
  assert.equal(page.status, 200);
  const consent = await form('/oauth/authorize', { ...params, decision: 'approve', context });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location') ?? '');
  assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT_URI);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code') ?? '';
  const exchange = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  assert.equal(exchange.status, 200);
  const replay = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  assert.equal(replay.body.error, 'invalid_grant');
  return asTokens(exchange.body);
}

async function main(): Promise<void> {
  console.log(`Flow OAuth Pennylane contre ${BASE_URL}\n`);

  assert.deepEqual(await (await fetch(`${BASE_URL}/health`)).json(), { status: 'ok' });
  step('GET /health → {"status":"ok"}');

  // 1. Autorisation + échange du code (company token, dossier 101)
  const tokensA = await connect('company:101', 'customers:readonly customer_invoices:readonly');
  step(
    `authorize → 302 ?code&state → POST /oauth/token (expires_in=${tokensA.expires_in}) ; code rejoué → invalid_grant`,
  );

  // 2. Vraie API, via le point d'entrée unique
  const me = await api('/api/external/v2/me', tokensA.access_token);
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { company: { id: number; name: string }; scopes: string[] };
  assert.equal(meBody.company.id, 101);
  assert.deepEqual(meBody.scopes, ['customers:readonly', 'customer_invoices:readonly']);
  assert.equal((await api('/api/external/v2/customer_invoices?limit=1', tokensA.access_token)).status, 200);
  step(
    `GET ${BASE_URL}/api/external/v2/me et /customer_invoices → 200, dossier 101 (${meBody.company.name})`,
  );

  assert.equal((await api('/api/external/v2/suppliers', tokensA.access_token)).status, 403);
  step('GET /suppliers sans le scope suppliers:readonly → 403');

  assert.equal((await api('/api/external/v2/me', tokensA.access_token, {}, API_SERVER_URL)).status, 200);
  step(`Même token directement sur l'api-server (${API_SERVER_URL}) → 200`);

  // 3. Firm token : portefeuille du cabinet sur l'API Firm, dossier choisi sur l'API Company
  const firm = await connect('firm:1', 'companies:readonly customers:readonly');
  const companies = await api('/api/external/firm/v1/companies', firm.access_token);
  assert.equal(companies.status, 200);
  const portfolio = ((await companies.json()) as { items: { id: number }[] }).items.map((c) => c.id);
  assert.deepEqual(portfolio, [101, 102, 103, 104]);
  const fromFirm = await api('/api/external/v2/customers?limit=1', firm.access_token, {
    'X-Company-Id': '102',
  });
  assert.equal(fromFirm.status, 200);
  step(
    'Firm token : /api/external/firm/v1/companies → dossiers 101 à 104 ; API Company + X-Company-Id: 102 → 200',
  );

  // 4. Jetons statiques toujours acceptés
  assert.equal((await api('/api/external/v2/me', 'mock_company_101_full')).status, 200);
  step('Jeton statique mock_company_101_full via le point d’entrée → 200');

  // 5. Expiration
  if (tokensA.expires_in <= MAX_WAIT_FOR_EXPIRATION) {
    console.log(`  … attente de ${tokensA.expires_in + 1} s pour l'expiration de l'access token`);
    await new Promise((resolve) => setTimeout(resolve, (tokensA.expires_in + 1) * 1000));
    const expired = await api('/api/external/v2/me', tokensA.access_token);
    assert.equal(expired.status, 401);
    assert.deepEqual(await expired.json(), { status: 401, error: 'The access token expired' });
    step('Access token expiré → 401 The access token expired');
  } else {
    console.log(`  ⚠ expiration non testée : relancer avec ACCESS_TOKEN_TTL<=${MAX_WAIT_FOR_EXPIRATION}`);
  }

  // 6. Refresh + rotation
  const refreshA = await refresh(tokensA.refresh_token);
  assert.equal(refreshA.status, 200);
  const tokensB = asTokens(refreshA.body);
  assert.equal((await api('/api/external/v2/me', tokensB.access_token)).status, 200);
  step('POST /oauth/token (refresh_token A) → nouvelle paire B, acceptée par l’API');

  assert.equal((await api('/api/external/v2/me', tokensA.access_token)).status, 401);
  assert.equal((await refresh(tokensA.refresh_token)).body.error, 'invalid_grant');
  step('Ancien access token A → 401 ; ancien refresh token A → invalid_grant');

  const tokensC = asTokens((await refresh(tokensB.refresh_token)).body);
  assert.equal((await refresh(tokensB.refresh_token)).body.error, 'invalid_grant');
  step('Rotation en chaîne B → C, B rejeté ensuite');

  // 7. Révocation
  const revoke = await form('/oauth/revoke', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    token: tokensC.access_token,
  });
  assert.equal(revoke.status, 200);
  assert.equal(await revoke.text(), '');
  const revoked = await api('/api/external/v2/me', tokensC.access_token);
  assert.deepEqual(await revoked.json(), { status: 401, error: 'The access token was revoked' });
  assert.equal((await refresh(tokensC.refresh_token)).body.error, 'invalid_grant');
  step('POST /oauth/revoke → 200 vide ; API → 401 revoked ; refresh → invalid_grant');

  console.log('\nFlow complet OK');
}

main().catch((error: unknown) => {
  console.error('\n✗ Échec :', error instanceof Error ? error.message : error);
  process.exit(1);
});
