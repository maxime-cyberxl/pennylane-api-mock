// Étape 2 : construit db-company.json / db-firm.json / db-firm-group.json à partir des gabarits (extract.mjs)
import { readFileSync, writeFileSync } from 'node:fs';
import { loadTemplates, makeRenderer, makeIds, API_DEF } from './lib.mjs';
import { COMPANIES } from './profiles.mjs';
import { generateCompany } from './company-gen.mjs';
import { generateFirmGroup } from './firm-group-gen.mjs';
import { genRoutes } from '../server/gen-routes.mjs';
import { genTokens } from './tokens.mjs';

const out = (name) => new URL(`../../fixtures/db-${name}.json`, import.meta.url);
const writeDb = (name, db) => writeFileSync(out(name), JSON.stringify(db, null, 2) + '\n');
const strip = (db) => { delete db.__meta; return db; };

export function buildFirmGroup() {
  const templates = loadTemplates('firm-group');
  const renderer = makeRenderer(templates);
  const { C } = generateFirmGroup({ templates, renderer });
  return { db: C, untouched: renderer.untouched, templates };
}

// company et firm : tous les dossiers du cabinet, identifiants partagés, chaque objet porte son dossier (_company)
export function buildMulti(api) {
  const templates = loadTemplates(api);
  const renderer = makeRenderer(templates);
  const ids = makeIds();
  const spec = JSON.parse(readFileSync(new URL(`../../specs/${API_DEF[api].file}`, import.meta.url)));
  const scopes = Object.keys(spec.components.securitySchemes.oauth2.flows.authorizationCode.scopes);
  const db = {};
  const skipped = {};
  const meta = {};
  for (const P of COMPANIES) {
    const base = `https://app.pennylane.com${API_DEF[api].prefix}${api === 'firm' ? `/companies/${P.id}` : ''}`;
    const { C, idn, skipped: sk } = generateCompany({ P, api, ids, templates, renderer, base, scopes });
    Object.entries(C).forEach(([k, v]) => k !== '__meta' && (db[k] = [...(db[k] ?? []), ...v]));
    meta[P.id] = C.__meta;
    Object.assign(skipped, sk);
    if (api === 'firm') (db.companies ??= []).push(renderer.render('companies', { id: P.id, name: `${P.name} ${P.legal}`, billing_company_name: P.trade_name, siren: idn.siren, address: P.address, city: P.city, postal_code: P.postal_code, activity_nomenclature: 'NAFRev2', activity_code: P.activity_code, external_id: P.external_id, client_code: P.client_code, _company: P.id }));
  }
  return { db, meta, untouched: renderer.untouched, skipped, templates };
}

if (process.argv[1].endsWith('build.mjs')) {
  const which = process.argv.slice(2);
  const want = (n) => !which.length || which.includes(n);
  for (const api of ['company', 'firm']) {
    if (!want(api)) continue;
    const { db, meta, untouched, skipped } = buildMulti(api);
    writeDb(api, db);
    console.log(`db-${api}.json`, Object.keys(db).length, 'collections', JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([, v]) => v).map(([k, v]) => [k, `${v.invoices} fact. clients, ${v.transactions} transactions`]))));
    if (process.env.UNTOUCHED) {
      for (const [k, v] of Object.entries(untouched)) console.log('  non renseigné', k, [...v].join(','));
      if (api === 'firm') console.log('  endpoints company-v2 absents de firm-v1 (ignorés):', Object.keys(skipped).join(', '));
    }
  }
  if (want('firm-group')) {
    const { db, untouched } = buildFirmGroup();
    writeDb('firm-group', db);
    console.log('db-firm-group.json', Object.keys(db).length, 'collections');
    if (process.env.UNTOUCHED) for (const [k, v] of Object.entries(untouched)) console.log('  non renseigné', k, [...v].join(','));
  }
  for (const api of Object.keys(API_DEF)) if (want(api)) console.log('routes', api, genRoutes(api));
  if (!which.length) console.log('tokens', Object.keys(genTokens()).length);
}
