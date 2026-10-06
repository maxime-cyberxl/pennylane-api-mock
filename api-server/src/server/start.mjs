// Lance un json-server "Pennylane" : node src/server/start.mjs <company|firm|firm-group> [--reset] [--port N] [--no-auth]
// La base servie est une copie de travail (.db/, ou --work-dir <dir>) pour préserver db-<api>.json ; --reset la régénère.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import jsonServer from 'json-server';
import { plMiddleware, rewriter, auth } from './middleware.mjs';
import { API_DEF } from '../generator/lib.mjs';

const api = process.argv[2];
if (!API_DEF[api]) { console.error('usage: start.mjs <company|firm|firm-group> [--reset] [--port N] [--no-auth]'); process.exit(1); }
const flag = (n) => process.argv.includes(n);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || API_DEF[api].port;
const root = new URL('../../', import.meta.url);
const workDir = process.argv.includes('--work-dir') ? process.argv[process.argv.indexOf('--work-dir') + 1] : '.db';
const seed = new URL(`fixtures/db-${api}.json`, root);
const work = new URL(`${workDir}/db-${api}.json`, root);
mkdirSync(new URL(`${workDir}/`, root), { recursive: true });
if (flag('--reset') && existsSync(work)) rmSync(work);
if (!existsSync(work)) copyFileSync(seed, work);

const server = jsonServer.create();
const router = jsonServer.router(work.pathname);
const routes = JSON.parse(readFileSync(new URL(`./generated/routes-${api}.json`, import.meta.url)));
const meta = JSON.parse(readFileSync(new URL(`./generated/meta-${api}.json`, import.meta.url)));
server.use(jsonServer.defaults({ logger: !flag('--quiet') }));
const tokens = JSON.parse(readFileSync(new URL('fixtures/tokens.json', root)));
const scopes = JSON.parse(readFileSync(new URL(`./generated/scopes-${api}.json`, import.meta.url)));
const authOn = !flag('--no-auth') && process.env.MOCK_AUTH !== 'off';
// Access tokens du mock OAuth : vérifiés par introspection (vide = jetons statiques uniquement)
const introspectionUrl = process.env.OAUTH_INTROSPECTION_URL ?? 'http://127.0.0.1:3000/_mock/introspect';
server.use(auth({ api, tokens, scopes, enabled: authOn, introspectionUrl }));
server.use(rewriter(routes));
server.use(plMiddleware({ api, db: router.db, meta }));
server.use(router);
const host = process.env.MOCK_HOST || '127.0.0.1'; // 0.0.0.0 dans Docker
server.listen(port, host, () => console.log(`[${api}] http://${host}:${port}${API_DEF[api].prefix}  (base: ${workDir}/db-${api}.json, auth: ${authOn ? 'on' : 'off'})`));
