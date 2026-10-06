// Contrôles qualité des db-*.json : (1) conformité de chaque objet au schéma OpenAPI de la réponse,
// (2) couverture de tous les GET de la spec, (3) cohérence comptable (écritures équilibrées, lettrage, TVA, banque…).
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { pathInfo, API_DEF, viewMeta } from './lib.mjs';

export const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true });
addFormats(ajv);
for (const f of ['string', 'int64', 'int32', 'float', 'double', 'binary']) ajv.addFormat(f, true);
const pub = (o) => (Array.isArray(o) ? o.map(pub) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, pub(v)])) : o);
// OpenAPI 3.0 : `nullable: true` + `enum` sans null rejette null, alors que l'API réelle documente null → on l'autorise
export const nullableEnums = (n) => {
  if (Array.isArray(n)) return n.map(nullableEnums);
  if (!n || typeof n !== 'object') return n;
  const o = Object.fromEntries(Object.entries(n).map(([k, x]) => [k, nullableEnums(x)]));
  if (o.nullable && Array.isArray(o.enum) && !o.enum.includes(null)) o.enum = [...o.enum, null];
  return o;
};
const cents = (s) => Math.round(Number(s) * 100);

export function validateSchemas(api, db, { verbose = false } = {}) {
  const raw = JSON.parse(readFileSync(new URL(`./.cache/${api}.json`, import.meta.url)));
  const problems = [];
  const meta = viewMeta(api);
  const ALIAS = { company_customers: 'customers', individual_customers: 'customers' };
  const COMPUTED = new Set(['trial_balance']);
  const coverage = { ok: [], missing: [], empty: [] };
  const seen = new Set();
  for (const [path, v] of Object.entries(raw)) {
    const info = pathInfo(path, API_DEF[api].prefix);
    const key = info.key;
    const data = db[ALIAS[key] ?? key] ?? (COMPUTED.has(key) ? [] : undefined);
    if (COMPUTED.has(key)) { coverage.ok.push(path + ' (calculé)'); continue; }
    if (data === undefined) { coverage.missing.push(path); continue; }
    if (Array.isArray(data) && data.length === 0) coverage.empty.push(path);
    if (ALIAS[key] || seen.has(key + v.kind)) { if (ALIAS[key]) coverage.ok.push(path + ' (alias)'); continue; }
    seen.add(key + v.kind);
    const schema = v.kind === 'list' ? v.itemSchema : v.schema;
    if (!schema) continue;
    const validate = ajv.compile(nullableEnums(schema));
    const items = Array.isArray(data) ? data : [data];
    // pour un endpoint détail, l'objet est validé contre le schéma détail ; pour une liste, contre le schéma d'item
    let bad = 0;
    const hide = v.kind === 'list' ? meta[key]?.detailOnly : meta[key]?.listOnly;
    for (const it0 of items) {
      if (v.kind === 'single' && Array.isArray(data) && info.detail === false && !['me', 'company_features'].includes(key)) continue;
      const it = { ...it0 };
      (hide ?? []).forEach((h) => delete it[h]);
      if (!validate(pub(it))) {
        bad++;
        if (bad <= 2) problems.push(`${key} (${path.replace(API_DEF[api].prefix, '')}) id=${it.id ?? it.number ?? '-'}: ${ajv.errorsText(validate.errors, { dataVar: '', separator: ' | ' }).slice(0, 300)}`);
      }
    }
    if (bad > 2) problems.push(`${key}: … ${bad} objets invalides au total`);
    coverage.ok.push(path);
  }
  return { problems, coverage };
}

// ── Cohérence comptable du dossier company-v2 ────────────────────────────────────────────────
export function checkCompany(db) {
  const errs = [];
  const has = (k) => Array.isArray(db[k]);
  const lines = db.ledger_entry_lines;
  const byEntry = {};
  lines.forEach((l) => (byEntry[l.ledger_entry.id] ??= []).push(l));
  for (const e of db.ledger_entries) {
    const ls = byEntry[e.id] ?? [];
    const d = ls.reduce((s, l) => s + cents(l.debit), 0), c = ls.reduce((s, l) => s + cents(l.credit), 0);
    if (e.status === 'draft') continue;
    if (!ls.length) errs.push(`écriture ${e.id} sans ligne`);
    else if (d !== c) errs.push(`écriture ${e.id} déséquilibrée D=${d} C=${c}`);
  }
  // sous-ressource de l'écriture = mêmes lignes
  const sub = {};
  (db.ledger_entries__ledger_entry_lines ?? []).forEach((l) => (sub[l._parent] ??= []).push(l.id));
  for (const [eid, ids] of Object.entries(sub)) if (ids.length !== (byEntry[eid] ?? []).length) errs.push(`écriture ${eid}: lignes en sous-ressource incohérentes`);
  // lettrage : chaque groupe est soldé, sur un même compte, et réciproque
  const lineById = Object.fromEntries(lines.map((l) => [l.id, l]));
  const seenGroups = new Set();
  for (const l of lines) {
    const ids = l.lettered_ledger_entry_lines.ids;
    if (!ids.length) continue;
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    if (!ids.includes(l.id)) errs.push(`ligne ${l.id} absente de son propre lettrage`);
    const g = ids.map((i) => lineById[i]);
    if (g.some((x) => !x)) { errs.push(`lettrage ${key}: ligne inconnue`); continue; }
    const bal = g.reduce((s, x) => s + cents(x.debit) - cents(x.credit), 0);
    if (bal !== 0) errs.push(`lettrage ${key} non soldé (${bal / 100})`);
    if (new Set(g.map((x) => x.ledger_account.id)).size !== 1) errs.push(`lettrage ${key} sur plusieurs comptes`);
    g.forEach((x) => { if ([...x.lettered_ledger_entry_lines.ids].sort((a, b) => a - b).join(',') !== key) errs.push(`lettrage non réciproque ligne ${x.id}`); });
  }
  // factures clients : totaux = somme des lignes, écriture = TTC, statut cohérent avec les règlements
  const invLines = {};
  (db.customer_invoices__invoice_lines ?? []).forEach((l) => (invLines[l._parent] ??= []).push(l));
  const txById = Object.fromEntries(db.transactions.map((t) => [t.id, t]));
  const matched = {};
  (db.transactions__matched_invoices ?? []).forEach((m) => (matched[`${m.type}:${m.id}`] ??= []).push(txById[m._parent]));
  const full = has('customer_invoices__invoice_lines');
  for (const inv of db.customer_invoices) {
    if (inv.draft) continue;
    if (!full) { const entry = db.ledger_entries.find((e) => e.id === inv.ledger_entry.id); if (!entry) errs.push(`facture ${inv.invoice_number}: écriture introuvable`); continue; }
    const ls = invLines[inv.id] ?? [];
    const ht = ls.reduce((s, l) => s + cents(l.currency_amount_before_tax), 0), tax = ls.reduce((s, l) => s + cents(l.tax), 0);
    if (ht !== cents(inv.currency_amount_before_tax)) errs.push(`facture ${inv.invoice_number}: HT ${ht} ≠ ${cents(inv.currency_amount_before_tax)}`);
    if (tax !== cents(inv.tax)) errs.push(`facture ${inv.invoice_number}: TVA incohérente`);
    if (cents(inv.amount) !== ht + tax) errs.push(`facture ${inv.invoice_number}: TTC ≠ HT+TVA`);
    const entry = db.ledger_entries.find((e) => e.id === inv.ledger_entry.id);
    if (!entry) { errs.push(`facture ${inv.invoice_number}: écriture introuvable`); continue; }
    const first = (byEntry[entry.id] ?? [])[0];
    if (Math.abs(cents(first.debit) - cents(first.credit)) !== Math.abs(cents(inv.amount))) errs.push(`facture ${inv.invoice_number}: ligne client ≠ TTC`);
    const paid = (matched[`customer:${inv.id}`] ?? []).reduce((s, t) => s + cents(t.amount), 0);
    const rem = cents(inv.remaining_amount_with_tax);
    if (inv.status === 'credit_note' || inv.status === 'cancelled') { if (rem !== 0) errs.push(`facture ${inv.invoice_number}: avoir/annulée avec reste ${rem}`); continue; }
    if (rem !== cents(inv.amount) - paid) errs.push(`facture ${inv.invoice_number}: reste dû ${rem} ≠ ${cents(inv.amount) - paid}`);
    if (inv.paid !== (rem === 0)) errs.push(`facture ${inv.invoice_number}: paid=${inv.paid} mais reste ${rem}`);
    if (inv.status === 'paid' && rem !== 0) errs.push(`facture ${inv.invoice_number}: payée avec reste`);
    if (inv.deadline < inv.date) errs.push(`facture ${inv.invoice_number}: échéance avant émission`);
    (matched[`customer:${inv.id}`] ?? []).forEach((t) => { if (t.date < inv.date) errs.push(`facture ${inv.invoice_number}: règlement ${t.id} antérieur à la facture`); });
    // la sous-ressource matched_transactions reflète les transactions
    const sm = db.customer_invoices__matched_transactions.filter((t) => t._parent === inv.id).length;
    if (sm !== (matched[`customer:${inv.id}`] ?? []).length) errs.push(`facture ${inv.invoice_number}: matched_transactions incohérent`);
  }
  for (const inv of full ? db.supplier_invoices : []) {
    const ls = db.supplier_invoices__invoice_lines.filter((l) => l._parent === inv.id);
    const ht = ls.reduce((s, l) => s + cents(l.currency_amount_before_tax), 0), tax = ls.reduce((s, l) => s + cents(l.tax), 0);
    if (ht !== cents(inv.currency_amount_before_tax) || ht + tax !== cents(inv.amount)) errs.push(`facture fournisseur ${inv.invoice_number}: totaux`);
    const paid = (matched[`supplier:${inv.id}`] ?? []).reduce((s, t) => s - cents(t.amount), 0);
    if (cents(inv.remaining_amount_with_tax) !== cents(inv.amount) - paid) errs.push(`facture fournisseur ${inv.invoice_number}: reste dû`);
    if (inv.paid !== (paid === cents(inv.amount))) errs.push(`facture fournisseur ${inv.invoice_number}: paid`);
  }
  // banque : solde courant cohérent et égal au solde du compte bancaire et du compte 512
  const tx = [...db.transactions].sort((a, b) => a.id - b.id);
  let run = 0;
  for (const t of tx) { run += cents(t.amount); if (cents(t.outstanding_balance) !== run) { errs.push(`transaction ${t.id}: solde courant ${t.outstanding_balance} ≠ ${run / 100}`); break; } }
  // les soldes de bilan se lisent sur l'exercice courant (l'à-nouveau reprend les soldes des exercices clos)
  const curFy = [...db.fiscal_years].sort((a, b) => a.start.localeCompare(b.start)).at(-1);
  const cur = lines.filter((l) => l.date >= curFy.start);
  const bank = db.bank_accounts[0];
  if (bank.balance !== undefined && cents(bank.balance) !== run) errs.push(`solde compte bancaire ${bank.balance} ≠ ${run / 100}`);
  const a512 = db.ledger_accounts.find((a) => a.number === '5121');
  const l512 = cur.filter((l) => l.ledger_account.id === a512.id).reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0);
  if (l512 !== run) errs.push(`compte 5121 (${l512 / 100}) ≠ solde bancaire (${run / 100})`);
  // chaque transaction a son écriture de banque du même montant
  // tiers : soldes des comptes 411/401 = reste dû des factures
  const acctById = Object.fromEntries(db.ledger_accounts.map((a) => [a.id, a]));
  const bal = (prefix) => cur.filter((l) => acctById[l.ledger_account.id].number.startsWith(prefix)).reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0);
  const recv = db.customer_invoices.filter((i) => !i.draft && !['credit_note', 'cancelled'].includes(i.status)).reduce((s, i) => s + cents(i.remaining_amount_with_tax), 0);
  if (bal('411') !== recv) errs.push(`solde 411 (${bal('411') / 100}) ≠ créances clients (${recv / 100})`);
  const pay = db.supplier_invoices.reduce((s, i) => s + cents(i.remaining_amount_with_tax), 0);
  if (-bal('401') !== pay) errs.push(`solde 401 (${-bal('401') / 100}) ≠ dettes fournisseurs (${pay / 100})`);
  // trial balance : Σ débits = Σ crédits, par exercice
  for (const fy of db.fiscal_years) {
    const inFy = lines.filter((l) => l.date >= fy.start && l.date <= fy.finish);
    const d = inFy.reduce((s, l) => s + cents(l.debit), 0), c = inFy.reduce((s, l) => s + cents(l.credit), 0);
    if (d !== c) errs.push(`exercice ${fy.start}: Σ débits ≠ Σ crédits`);
  }
  // références
  const idsOf = (k) => new Set((db[k] ?? []).map((x) => x.id));
  const refChecks = [['customer_invoices', 'customer', 'customers'], ['supplier_invoices', 'supplier', 'suppliers'], ['transactions', 'bank_account', 'bank_accounts'], ['ledger_entry_lines', 'ledger_account', 'ledger_accounts'], ['ledger_entry_lines', 'journal', 'journals'], ['sepa_mandates', 'customer', 'customers'], ['billing_subscriptions', 'customer', 'customers'], ['quotes', 'customer', 'customers']];
  for (const [coll, field, target] of refChecks) {
    if (!has(coll)) continue; const ids = idsOf(target); for (const x of db[coll]) if (x[field] && !ids.has(x[field].id)) errs.push(`${coll} ${x.id}: ${field}.id=${x[field].id} inconnu dans ${target}`); }
  for (const i of has('quotes') ? db.customer_invoices : []) { if (i.quote && !(db.quotes ?? []).find((q) => q.id === i.quote.id)) errs.push(`facture ${i.id}: devis inconnu`); }
  const invoicedQuotes = (db.quotes ?? []).filter((q) => q.status === 'invoiced');
  for (const q of invoicedQuotes) if (!db.customer_invoices.some((i) => i.quote?.id === q.id)) errs.push(`devis ${q.quote_number} "invoiced" sans facture liée`);
  return errs;
}

// Cohérence entre les trois bases : mêmes dossiers, mêmes SIREN, mêmes identifiants
export function checkCross({ company, firm, group }) {
  const errs = [];
  const fc = Object.fromEntries(firm.companies.map((c) => [c.id, c]));
  const gc = Object.fromEntries(group.companies.map((c) => [Number(c.id), c]));
  for (const id of Object.keys(fc).map(Number)) {
    if (!gc[id]) { errs.push(`dossier ${id} présent dans firm mais pas dans firm-group`); continue; }
    if (gc[id].reg_no !== fc[id].siren && !gc[id].not_yet_registered) errs.push(`dossier ${id}: SIREN firm ${fc[id].siren} ≠ firm-group ${gc[id].reg_no}`);
  }
  for (const me of company.me) if (me.company.reg_no !== fc[me.company.id]?.siren) errs.push(`me.company.reg_no ≠ siren firm (dossier ${me.company.id})`);
  const strip = (x) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => ['id', 'date', 'amount', 'label', 'currency_amount_before_tax', 'invoice_number'].includes(k))));
  for (const k of ['customer_invoices', 'supplier_invoices', 'transactions', 'ledger_entries', 'ledger_entry_lines', 'customers', 'suppliers']) {
    for (const id of [101, 102, 103]) {
      const a = company[k].filter((x) => x._company === id).map(strip).join('\n'), b = firm[k].filter((x) => x._company === id).map(strip).join('\n');
      if (a !== b) errs.push(`${k}: dossier ${id} différent entre db-company et db-firm`);
    }
  }
  const fu = new Set(group.users.map((u) => u.id));
  for (const u of group.companies__users) if (!fu.has(u.id)) errs.push(`companies__users: ${u.id} absent de users`);
  for (const c of group.companies) for (const k of ['accounting_manager_id', 'accountant_id', 'accounting_supervisor_id']) if (c[k] && !fu.has(c[k])) errs.push(`company ${c.id}: ${k}=${c[k]} inconnu`);
  const fids = new Set(group.firms.map((f) => f.id));
  for (const c of group.companies) if (!fids.has(c.firm_id)) errs.push(`company ${c.id}: firm_id inconnu`);
  return errs;
}

if (process.argv[1].endsWith('validate.mjs')) {
  const load = (n) => JSON.parse(readFileSync(new URL(`../../fixtures/db-${n}.json`, import.meta.url)));
  let total = 0;
  const db = { company: load('company'), firm: load('firm'), 'firm-group': load('firm-group') };
  for (const api of ['company', 'firm', 'firm-group']) {
    const { problems, coverage } = validateSchemas(api, db[api]);
    console.log(`[${api}] endpoints GET couverts: ${coverage.ok.length}, manquants: ${coverage.missing.length}, vides: ${coverage.empty.length}; ${problems.length} problème(s) de schéma`);
    coverage.missing.forEach((p) => console.log('  MANQUANT', p));
    coverage.empty.forEach((p) => console.log('  VIDE    ', p));
    problems.forEach((p) => console.log('  SCHEMA', p));
    total += problems.length + coverage.missing.length + coverage.empty.length;
    if (api !== 'firm-group') {
      const subs = [101, 102, 103].map((id) => [String(id), Object.fromEntries(Object.entries(db.firm).map(([k, v]) => [k, Array.isArray(v) ? (k === 'me' || k === 'company_features' ? v : v.filter((x) => x._company === id)) : v]))]);
      for (const [id, sub] of subs) { const errs = checkCompany(sub); console.log(`[${api}/${id}] ${errs.length} incohérence(s) comptable(s)`); errs.slice(0, 25).forEach((e) => console.log('  COMPTA', e)); total += errs.length; }
    }
  }
  const cross = checkCross({ company: db.company, firm: db.firm, group: db['firm-group'] });
  console.log(`[cross] ${cross.length} incohérence(s) entre APIs`);
  cross.forEach((e) => console.log('  CROSS', e));
  process.exitCode = total + cross.length ? 1 : 0;
}
