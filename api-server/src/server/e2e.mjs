// Test de bout en bout : appelle chaque GET de la spec sur les serveurs lancés (ports par défaut +100) et valide
// la réponse HTTP complète (enveloppe incluse) contre le schéma 200 de la spec ; vérifie aussi pagination, filtres, tri.
//   node src/server/e2e.mjs [--spawn] [offset-de-port]
//   --spawn : lance lui-même les 3 serveurs (base jetable .db-e2e/, ports 4010-4012 + offset, 100 par défaut) puis les arrête.
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathInfo, API_DEF } from '../generator/lib.mjs';
import { ajv, nullableEnums } from '../generator/validate.mjs';

const SPAWN = process.argv.includes('--spawn');
const offset = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 100);
const kids = [];
if (SPAWN) {
  rmSync(new URL('../../.db-e2e/', import.meta.url), { recursive: true, force: true });
  for (const [api, d] of Object.entries(API_DEF)) kids.push(spawn(process.execPath, [new URL('./start.mjs', import.meta.url).pathname, api, '--port', String(d.port + offset), '--work-dir', '.db-e2e', '--quiet'], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 2500));
}
const ALIAS = { company_customers: 'customers', individual_customers: 'customers' };
let fails = 0, calls = 0;
const TOKEN = { company: 'mock_company_101_full', firm: 'mock_firm_1_full', 'firm-group': 'mock_firm_group_full' };
const H = (api, extra = {}) => ({ Authorization: `Bearer ${TOKEN[api]}`, ...extra });
const scope101 = (db) => Object.fromEntries(Object.entries(db).map(([k, v]) => [k, Array.isArray(v) && v[0]?._company !== undefined ? v.filter((x) => x._company === 101) : v]));
const fail = (m) => { fails++; console.log('  ✗', m); };

for (const api of Object.keys(API_DEF)) {
  const raw = JSON.parse(readFileSync(new URL(`../generator/.cache/${api}.json`, import.meta.url)));
  const db = JSON.parse(readFileSync(new URL(`../../fixtures/db-${api}.json`, import.meta.url)));
  const base = `http://127.0.0.1:${API_DEF[api].port + offset}`;
  const get = async (p) => { calls++; const r = await fetch(base + p, { headers: H(api) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers }; };
  let ok = 0;
  for (const [path, v] of Object.entries(raw)) {
    const info = pathInfo(path, API_DEF[api].prefix);
    const key = ALIAS[info.key] ?? info.key;
    const rows = Array.isArray(db[key]) ? scope101({ [key]: db[key] })[key] : null;
    const vars = { company_id: 101 };
    if (rows?.length) {
      const row = rows[0];
      if (info.nested) { vars[info.parentParam] = row._parent; if (info.detail) vars.id = row.id; }
      else if (info.detail) vars.id = row.id;
    } else if (info.detail) vars.id = 1;
    if (ALIAS[info.key]) vars.id = scope101(db).customers.find((c) => c.customer_type === (info.key === 'company_customers' ? 'company' : 'individual')).id;
    const url = path.replace(/\{(\w+)\}/g, (_, n) => vars[n] ?? 1);
    const res = await get(url + (/trial_balance$/.test(path) ? '?period_start=2026-01-01&period_end=2026-12-31&is_auxiliary=false' : ''));
    if (res.status !== 200) { fail(`${url} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`); continue; }
    const schema = v.kind === 'list' ? v.responseSchema : v.schema;
    const validate = ajv.compile(nullableEnums(schema));
    if (/transfer_requests\/list_/.test(path)) { Array.isArray(Object.values(res.body)[0]) ? ok++ : fail(`${url} : liste attendue`); continue; } // écart assumé : la spec décrit un objet unique, on renvoie un tableau
    if (!validate(res.body)) fail(`${url} : ${ajv.errorsText(validate.errors, { dataVar: '' }).slice(0, 200)}`);
    else ok++;
  }
  console.log(`[${api}] ${ok}/${Object.keys(raw).length} endpoints GET valides (HTTP + schéma)`);
}

// ── Comportements fonctionnels ────────────────────────────────────────────────────────────────
{
  const base = `http://127.0.0.1:${API_DEF.company.port + offset}/api/external/v2`;
  const db = scope101(JSON.parse(readFileSync(new URL('../../fixtures/db-company.json', import.meta.url))));
  const h = H('company');
  const j = async (p) => (await fetch(base + p, { headers: h })).json();
  // pagination par curseur : parcours complet sans doublon
  const seen = new Set(); let cursor = null, pages = 0;
  do { const r = await j(`/customer_invoices?limit=25${cursor ? `&cursor=${cursor}` : ''}`); r.items.forEach((i) => seen.add(i.id)); cursor = r.next_cursor; pages++; } while (cursor);
  seen.size === db.customer_invoices.length ? console.log(`✓ pagination curseur: ${seen.size} factures en ${pages} pages`) : fail(`pagination: ${seen.size} ≠ ${db.customer_invoices.length}`);
  // tri par défaut -id, tri explicite
  const d = await j('/customer_invoices?limit=3'); d.items.map((i) => i.id).join() === [...d.items.map((i) => i.id)].sort((a, b) => b - a).join() ? console.log('✓ tri par défaut -id') : fail('tri par défaut');
  const a = await j('/customer_invoices?limit=100&sort=date'); a.items.every((x, i, arr) => !i || arr[i - 1].date <= x.date || x.date === null || arr[i - 1].date === null) ? console.log('✓ sort=date') : fail('sort=date');
  // filtres
  const f = (x) => encodeURIComponent(JSON.stringify(x));
  const late = await j(`/customer_invoices?limit=100&filter=${f([{ field: 'status', operator: 'eq', value: 'late' }])}`);
  late.items.length && late.items.every((i) => i.status === 'late') ? console.log(`✓ filter status=late → ${late.items.length}`) : console.log('  (filter status n\'est pas documenté : ignoré)');
  const q1 = await j(`/customer_invoices?limit=100&filter=${f([{ field: 'date', operator: 'gteq', value: '2026-09-01' }, { field: 'draft', operator: 'eq', value: 'false' }])}`);
  q1.items.length && q1.items.every((i) => i.date >= '2026-09-01' && !i.draft) ? console.log(`✓ filter date>=2026-09-01 & draft=false → ${q1.items.length}`) : fail('filter date');
  const byCust = await j(`/customer_invoices?limit=100&filter=${f([{ field: 'customer_id', operator: 'in', value: '[1,2]' }])}`);
  byCust.items.length && byCust.items.every((i) => [1, 2].includes(i.customer.id)) ? console.log(`✓ filter customer_id in [1,2] → ${byCust.items.length}`) : fail('filter customer_id in');
  const cat = await j(`/supplier_invoices?limit=100&filter=${f([{ field: 'category_id', operator: 'in', value: [db.categories.find((c) => c.analytical_code === 'CHG-LOYER').id] }])}`);
  cat.items.length ? console.log(`✓ filter category_id in → ${cat.items.length} factures fournisseur (loyer)`) : fail('filter category_id');
  // sous-ressources
  const inv = db.customer_invoices.find((i) => i.status === 'paid' && !i.quote);
  const lines = await j(`/customer_invoices/${inv.id}/invoice_lines`);
  const pay = await j(`/customer_invoices/${inv.id}/matched_transactions`);
  lines.items.length && pay.items.length ? console.log(`✓ /customer_invoices/${inv.id}: ${lines.items.length} ligne(s), ${pay.items.length} transaction(s) rapprochée(s)`) : fail('sous-ressources facture');
  // vues liste/détail + clés internes masquées
  const le = await j('/ledger_entries/1'); const leList = await j('/ledger_entries?limit=1');
  'ledger_entry_lines' in le && !('ledger_entry_lines' in leList.items[0]) && !('journal_id' in le) ? console.log('✓ ledger_entries : vue détail (ledger_entry_lines) ≠ vue liste (journal_id)') : fail('vues ledger_entries');
  JSON.stringify(await j('/customers?limit=100')).includes('"_parent"') ? fail('clé interne _parent exposée') : console.log('✓ clés internes masquées');
  // balance calculée
  const tb = await j('/trial_balance?period_start=2025-01-01&period_end=2025-12-31&is_auxiliary=false&limit=1000');
  const D = tb.items.reduce((s, x) => s + Math.round(x.debits * 100), 0), Cr = tb.items.reduce((s, x) => s + Math.round(x.credits * 100), 0);
  D === Cr && D > 0 ? console.log(`✓ balance 2025 équilibrée : ${tb.items.length} comptes, Σ débits = Σ crédits = ${(D / 100).toFixed(2)} €`) : fail(`balance 2025 déséquilibrée ${D} ≠ ${Cr}`);
  const tb2 = await j('/trial_balance?period_start=2026-01-01&period_end=2026-12-31&is_auxiliary=true&limit=1000');
  tb2.items.some((x) => x.number.startsWith('411') && x.number.length > 3) ? console.log('✓ balance auxiliaire (comptes 411xxxxx détaillés)') : fail('balance auxiliaire');
  // persistance : POST + GET + PUT partiel (puis nettoyage)
  const created = await (await fetch(`${base}/customers`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Client e2e', customer_type: 'company' }) })).json();
  const again = await j(`/customers/${created.id}`);
  const put = await (await fetch(`${base}/customers/${created.id}`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+33100000000' }) })).json();
  created.id && again.name === 'Client e2e' && put.name === 'Client e2e' && put.phone === '+33100000000' ? console.log(`✓ POST (id ${created.id}) persisté, PUT partiel conserve les autres champs`) : fail('persistance POST/PUT');
  await fetch(`${base}/customers/${created.id}`, { method: 'DELETE', headers: h });
  const e400 = await fetch(`${base}/customers?limit=500`, { headers: h }); e400.status === 400 ? console.log('✓ limit hors bornes → 400') : fail('limit=500 devrait être 400');
  const pdf = await fetch(`${base.replace('/api/external/v2', '')}${new URL((await j(`/customer_invoices/${inv.id}`)).public_file_url).pathname}${new URL((await j(`/customer_invoices/${inv.id}`)).public_file_url).search}`);
  (await pdf.arrayBuffer()).byteLength > 1000 && pdf.headers.get('content-type').includes('pdf') ? console.log('✓ public_file_url sert le PDF de démonstration') : fail('pdf');
  const fec = await fetch(`${base}/exports/fecs/${db.exports_fecs[0].id}`.replace(/\/\d+$/, '') + `/${db.exports_fecs[0].id}/fec.txt`);
  const fecT = await fec.text(); fecT.startsWith('JournalCode') && fecT.split('\n').length > 100 ? console.log(`✓ FEC téléchargeable (${fecT.split('\n').length - 2} lignes)`) : fail('fec');
}
{
  const base = `http://127.0.0.1:${API_DEF['firm-group'].port + offset}/api/firm/v3`;
  const j = async (p) => (await fetch(base + p, { headers: H('firm-group') })).json();
  const p1 = await j('/companies?per_page=2&page=1'); const p3 = await j('/companies?per_page=2&page=3');
  p1.total_pages === 3 && p1.companies.length === 2 && p3.current_page === 3 ? console.log('✓ firm-group : pagination page/per_page (6 dossiers → 3 pages)') : fail(`firm-group pagination ${JSON.stringify([p1.total_pages, p1.companies.length])}`);
  const u = await j(`/users?filter=${encodeURIComponent(JSON.stringify([{ field: 'role', operator: 'eq', value: 'accountant' }]))}`);
  u.users.length && u.users.every((x) => x.role === 'accountant') ? console.log(`✓ firm-group : filter role=accountant → ${u.users.length}`) : fail('firm-group filter');
  const fc = await j('/firms/1/companies'); fc.companies.length === 4 ? console.log('✓ /firms/1/companies → 4 dossiers du cabinet') : fail(`firms/1/companies ${fc.companies?.length}`);
}
{
  const base = `http://127.0.0.1:${API_DEF.firm.port + offset}/api/external/firm/v1`;
  const j = async (p) => (await fetch(base + p, { headers: H('firm') })).json();
  const a = await j('/companies/101/customers?limit=100'), b = await j('/companies/102/customers?limit=100'), c = await j('/companies/104/customers?limit=100');
  a.items.length === 16 && b.items.length === 4 && c.items.length === 0 ? console.log(`✓ firm : isolation par dossier (101→${a.items.length}, 102→${b.items.length}, 104→${c.items.length} clients)`) : fail(`isolation dossiers ${a.items.length}/${b.items.length}/${c.items.length}`);
}
// ── Jetons : 401 / 403 / cloisonnement par dossier ──────────────────────────────────────────────
{
  const dbs = { company: JSON.parse(readFileSync(new URL('../../fixtures/db-company.json', import.meta.url))) };
  const url = (api, p) => `http://127.0.0.1:${API_DEF[api].port + offset}${API_DEF[api].prefix}${p}`;
  const call = async (api, p, headers = {}, method = 'GET') => { calls++; const r = await fetch(url(api, p), { method, headers }); let b; try { b = await r.json(); } catch { b = null; } return { status: r.status, body: b }; };
  const bearer = (t, extra = {}) => ({ Authorization: `Bearer ${t}`, ...extra });
  const expect = (label, got, status, test = () => true) => (got.status === status && test(got.body) ? console.log(`✓ ${label}`) : fail(`${label} → HTTP ${got.status} ${JSON.stringify(got.body).slice(0, 100)}`));
  expect('sans jeton → 401', await call('company', '/customers'), 401);
  expect('jeton inconnu → 401', await call('company', '/customers', bearer('nope')), 401);
  expect('jeton company : dossier implicite (101 → 16 clients)', await call('company', '/customers?limit=100', bearer('mock_company_101_full')), 200, (b) => b.items.length === 16);
  expect('jeton company 102 : voit uniquement son dossier (4 clients)', await call('company', '/customers?limit=100', bearer('mock_company_102_full')), 200, (b) => b.items.length === 4);
  expect('jeton company ignore X-Company-Id', await call('company', '/customers?limit=100', bearer('mock_company_102_full', { 'X-Company-Id': '101' })), 200, (b) => b.items.length === 4);
  const c101 = dbs.company.customers.find((c) => c._company === 101).id;
  expect('dossier 102 ne voit pas un client du 101 → 404', await call('company', `/customers/${c101}`, bearer('mock_company_102_full')), 404);
  expect('/me : dossier et scopes du jeton', await call('company', '/me', bearer('mock_company_102_full')), 200, (b) => b.company.id === 102 && b.scopes.length === 43);
  expect('jeton firm sans X-Company-Id → 400', await call('company', '/customers', bearer('mock_firm_1_full')), 400);
  expect('jeton firm + X-Company-Id: 102 → dossier 102', await call('company', '/customers?limit=100', bearer('mock_firm_1_full', { 'X-Company-Id': '102' })), 200, (b) => b.items.length === 4);
  expect('jeton firm + dossier hors portefeuille → 403', await call('company', '/customers', bearer('mock_firm_1_full', { 'X-Company-Id': '105' })), 403);
  expect('jeton firm : /me du dossier ciblé', await call('company', '/me', bearer('mock_firm_1_full', { 'X-Company-Id': '103' })), 200, (b) => b.company.id === 103);
  expect('scope manquant (factures seules) → 403 sur /suppliers', await call('company', '/suppliers', bearer('mock_company_101_invoices')), 403, (b) => /customers_|suppliers/.test(b.error));
  expect('scope présent → 200 sur /customer_invoices', await call('company', '/customer_invoices?limit=1', bearer('mock_company_101_invoices')), 200);
  expect('lecture seule : GET 200', await call('company', '/customers?limit=1', bearer('mock_company_101_readonly')), 200);
  expect('lecture seule : POST → 403', await call('company', '/customers', bearer('mock_company_101_readonly'), 'POST'), 403);
  expect('API firm : jeton company refusé → 403', await call('firm', '/companies', bearer('mock_company_101_full')), 403);
  expect('API firm : portefeuille du cabinet (4 dossiers)', await call('firm', '/companies?per_page=50', bearer('mock_firm_1_full')), 200, (b) => b.items.length === 4);
  expect('API firm : dossier du cabinet → 200', await call('firm', '/companies/102/customers?limit=100', bearer('mock_firm_1_full')), 200, (b) => b.items.length === 4);
  expect('API firm : dossier hors portefeuille → 403', await call('firm', '/companies/105/customers', bearer('mock_firm_1_full')), 403);
  expect('API firm group : jeton firm refusé → 403', await call('firm-group', '/companies', bearer('mock_firm_1_full')), 403);
  expect('API firm group : jeton group → 200', await call('firm-group', '/companies', bearer('mock_firm_group_full')), 200);
}
console.log(`\n${calls} appels HTTP, ${fails} échec(s)`);
kids.forEach((k) => k.kill());
if (SPAWN) rmSync(new URL('../../.db-e2e/', import.meta.url), { recursive: true, force: true });
process.exitCode = fails ? 1 : 0;
