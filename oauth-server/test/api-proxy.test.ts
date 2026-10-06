import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer } from './support/test-server.js';

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Faux api-server : renvoie ce qu'il a reçu, ou un PDF pour /file.pdf. */
let received: Received[] = [];
let upstream: http.Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.endsWith('/file.pdf')) {
        res
          .writeHead(200, { 'Content-Type': 'application/pdf' })
          .end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
        return;
      }
      res.writeHead(req.headers.authorization ? 201 : 401, {
        'Content-Type': 'application/json',
        'X-Upstream': 'yes',
      });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream.close();
});

const serverWithFakeApi = () => {
  received = [];
  return createTestServer(
    {},
    {
      apiRoutes: [
        { prefix: '/api/external/v2', target: upstreamUrl },
        { prefix: '/api/external/firm/v1', target: upstreamUrl },
        { prefix: '/api/firm/v3', target: upstreamUrl },
      ],
    },
  );
};

describe("relais des API vers l'api-server", () => {
  it.each([
    '/api/external/v2/customers',
    '/api/external/firm/v1/companies/101/journals',
    '/api/firm/v3/users',
  ])('relaie %s avec sa query string', async (path) => {
    const { http: client } = serverWithFakeApi();
    const response = await client.get(`${path}?limit=2&filter=%5B%5D`).set('Authorization', 'Bearer abc');

    expect(response.status).toBe(201);
    expect(response.headers['x-upstream']).toBe('yes');
    expect(received[0]?.url).toBe(`${path}?limit=2&filter=%5B%5D`);
  });

  it("transmet le Bearer tel quel (jeton statique ou token OAuth : c'est l'api-server qui vérifie)", async () => {
    const { http: client } = serverWithFakeApi();
    await client.get('/api/external/v2/me').set('Authorization', 'Bearer mock_company_101_full');
    expect(received[0]?.headers.authorization).toBe('Bearer mock_company_101_full');
  });

  it("conserve l'en-tête Host, pour que les URLs renvoyées pointent vers ce serveur", async () => {
    const { http: client } = serverWithFakeApi();
    await client.get('/api/external/v2/me').set('Host', 'localhost:3000');
    expect(received[0]?.headers.host).toBe('localhost:3000');
  });

  it('relaie méthode et corps (POST JSON)', async () => {
    const { http: client } = serverWithFakeApi();
    await client
      .post('/api/external/v2/customers')
      .set('Authorization', 'Bearer abc')
      .send({ name: 'Nouveau client' });

    expect(received[0]).toMatchObject({ method: 'POST', body: '{"name":"Nouveau client"}' });
    expect(received[0]?.headers['content-type']).toContain('application/json');
  });

  it('relaie les statuts d’erreur et les réponses binaires sans les modifier', async () => {
    const { http: client } = serverWithFakeApi();
    expect((await client.get('/api/external/v2/me')).status).toBe(401);

    const pdf = await client.get('/api/external/v2/public/file.pdf').buffer(true);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect([...(pdf.body as Buffer)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x00]);
  });

  it('journalise le chemin complet, sans la query string', async () => {
    const { http: client, logger } = serverWithFakeApi();
    await client.get('/api/external/v2/customers?secret=1').set('Authorization', 'Bearer abc');
    expect(logger.lines).toContainEqual(
      expect.stringMatching(/^GET \/api\/external\/v2\/customers 201 \d+ms$/),
    );
    expect(logger.lines.join('\n')).not.toContain('secret');
  });

  it("répond 502 si l'api-server ne répond pas", async () => {
    const { http: client } = createTestServer(
      {},
      { apiRoutes: [{ prefix: '/api/external/v2', target: 'http://127.0.0.1:1' }] },
    );
    const response = await client.get('/api/external/v2/me');
    expect(response.status).toBe(502);
  });

  it('ne relaie pas les chemins hors des 3 API', async () => {
    const { http: client } = serverWithFakeApi();
    expect((await client.get('/api/other')).status).toBe(404);
    expect(received).toHaveLength(0);
  });
});
