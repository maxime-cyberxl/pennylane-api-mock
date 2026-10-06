// Génère l'historique comptable cohérent d'un dossier (clients, fournisseurs, factures, écritures équilibrées,
// transactions bancaires, lettrage, TVA, paie…) puis le rend selon les gabarits de l'API demandée (company-v2 / firm-v1).
// Tout est déterministe (PRNG seedé) : les données du dossier 101 sont identiques dans db-company et db-firm.
import {
  rng, NOW, addDays, addMonths, endOfMonth, clampDay, nextWorkday, months, ts, money, round, VAT,
  siren as mkSiren, siret as mkSiret, frVat, ibanFR, slug, code, b64,
} from './lib.mjs';

export const identity = (P) => {
  const r = rng(P.id * 31);
  const siren = mkSiren(r);
  return { siren, siret: mkSiret(siren, 1), vat: frVat(siren), iban: ibanFR(r) };
};

const HOST = 'https://app.pennylane.com';
const PCG = {
  1013: 'Capital souscrit - appelé, versé', 120: 'Résultat de l\'exercice (bénéfice)', 129: 'Résultat de l\'exercice (perte)',
  2183: 'Matériel de bureau et informatique', 28183: 'Amortissements du matériel de bureau et informatique',
  401: 'Fournisseurs', 411: 'Clients', 421: 'Personnel - rémunérations dues', 431: 'Sécurité sociale',
  44551: 'TVA à décaisser', 44566: 'TVA déductible sur autres biens et services', 44567: 'Crédit de TVA à reporter', 44571: 'TVA collectée',
  5121: 'Banque', 641: 'Rémunérations du personnel', 645: 'Charges de sécurité sociale et de prévoyance',
  627: 'Services bancaires et assimilés', 6811: 'Dotations aux amortissements des immobilisations',
  701: 'Ventes de produits finis', 706: 'Prestations de services',
};

const catDefs = {
  in: { web: ['Création de sites web', 'REV-WEB'], brand: ['Identité visuelle', 'REV-BRAND'], conseil: ['Conseil & formation', 'REV-CONSEIL'], maintenance: ['Maintenance & hébergement', 'REV-MAINT'], traiteur: ['Traiteur & événements', 'REV-TRAIT'], livraison: ['Livraisons professionnelles', 'REV-LIVR'], soins: ['Soins de kinésithérapie', 'REV-SOINS'] },
  out: { loyer: ['Loyer & charges', 'CHG-LOYER'], assurance: ['Assurances', 'CHG-ASSUR'], saas: ['Logiciels & hébergement', 'CHG-SAAS'], telecom: ['Télécom & internet', 'CHG-TEL'], honoraires: ['Honoraires', 'CHG-HONO'], banque: ['Frais bancaires', 'CHG-BANQUE'], fournitures: ['Fournitures', 'CHG-FOURN'], reception: ['Réceptions', 'CHG-RECEP'], deplacement: ['Déplacements', 'CHG-DEPL'], marketing: ['Communication', 'CHG-COM'], materiel: ['Matériel informatique', 'CHG-MAT'], formation: ['Formation', 'CHG-FORM'], matieres: ['Matières premières', 'CHG-MATIERES'], energie: ['Énergie', 'CHG-ENERGIE'], entretien: ['Entretien & réparations', 'CHG-ENTRET'], salaires: ['Salaires & charges', 'CHG-SAL'], impots: ['Impôts & taxes', 'CHG-TAXES'] },
};

const termDays = { upon_receipt: 0, '7_days': 7, '15_days': 15, '30_days': 30, '45_days': 45, '60_days': 60 };
export const dueDate = (date, cond) =>
  cond === '30_days_end_of_month' ? endOfMonth(addDays(date, 30)) : cond === '45_days_end_of_month' ? endOfMonth(addDays(date, 45)) : addDays(date, termDays[cond] ?? 0);

export function generateCompany({ P, api, ids, templates, renderer, base, scopes }) {
  const firm = api === 'firm';
  const r = rng(P.id * 7919 + 13);
  const { render } = renderer;
  const idn = identity(P);
  const C = {}; // collections json-server
  const skipped = {};
  const cnt = {}; // compteurs de numérotation
  const nextNo = (k) => (cnt[k] = (cnt[k] ?? 0) + 1);
  const url = (path) => `${base}${path}`;
  const ref = (res, id, extra = {}) => ({ id, url: url(`/${res}/${id}`), ...extra });
  const add = (key, values, parent) => {
    if (!templates[key]) { (skipped[key] ??= 0), skipped[key]++; return null; }
    const item = render(key, { ...values, ...(parent !== undefined ? { _parent: parent } : {}), _company: P.id });
    (C[key] ??= []).push(item);
    return item;
  };
  if (!firm) {
    // /me et /company/features : une ligne par dossier (le serveur renvoie celle du dossier ciblé par le jeton)
    const u = P.users[0];
    C.me = [{ user: { id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, locale: 'fr' }, company: { id: P.id, name: P.name, reg_no: idn.siren, accounting_logic: 'FR_PCG' }, scopes, _company: P.id }];
    C.company_features = [{ installments: true, _company: P.id }];
  }
  if (P.empty) return { C, idn, skipped };

  const START = P.start;
  const FY = [{ start: '2025-01-01', finish: '2025-12-31' }, { start: '2026-01-01', finish: '2026-12-31' }].filter((f) => f.finish >= START);
  const allMonths = months(START, NOW);

  // ── Référentiels ───────────────────────────────────────────────────────────────────────────
  const journals = {};
  for (const [c, label, type] of [['VT', 'Ventes', 'sale'], ['AC', 'Achats', 'purchase'], ['BQ1', `${P.bank.name} - compte principal`, 'bank'], ['OD', 'Opérations diverses', 'miscellaneous'], ['AN', 'À nouveaux', 'opening']]) {
    const id = ids('journals');
    journals[c] = { id, code: c, label, type };
    add('journals', { id, code: c, label, type });
  }
  const jref = (c) => ref('journals', journals[c].id);

  const accts = {};
  const acct = (number, label, opt = {}) => {
    if (accts[number]) return accts[number];
    const id = ids('ledger_accounts');
    accts[number] = { id, number: String(number), label: label ?? PCG[number] ?? `Compte ${number}`, letterable: !!opt.letterable, aux: !!opt.aux };
    add('ledger_accounts', { id, number: String(number), label: accts[number].label, vat_rate: 'any', country_alpha2: 'FR', enabled: true, type: opt.aux ? 'auxiliary' : 'general', letterable: accts[number].letterable, archived_at: null, created_at: ts(START, r), updated_at: ts(START, r) });
    return accts[number];
  };
  for (const n of [1013, 120, 129, 2183, 28183, 401, 411, 421, 431, 641, 645, 627, 6811, P.salesAccount ?? '706']) acct(n, undefined, { letterable: [401, 411, 421, 431].includes(n) });
  const hasVat = P.vat_frequency !== 'not_applicable';
  if (hasVat) for (const n of [44551, 44566, 44567, 44571]) acct(n, undefined, { letterable: n === 44551 });
  const aRef = (a) => ({ id: a.id, number: a.number, url: url(`/ledger_accounts/${a.id}`) });
  const aRefId = (a) => ({ id: a.id, url: url(`/ledger_accounts/${a.id}`) });

  const bankAcctL = acct(5121, `${P.bank.name} - compte principal`);
  const bankEst = ids('bank_establishments');
  add('bank_establishments', { id: bankEst, name: P.bank.name, created_at: ts(START, r), updated_at: ts(START, r) });
  const bankAcct = { id: ids('bank_accounts'), balance: 0 };

  // Catégories analytiques
  const grpIn = ids('category_groups'), grpOut = ids('category_groups');
  const cats = { in: {}, out: {} };
  for (const [gid, label] of [[grpIn, 'Types de recettes'], [grpOut, 'Types de dépenses']]) {
    add('category_groups', { id: gid, label, categories: { url: url(`/category_groups/${gid}/categories`) }, created_at: ts(START, r), updated_at: ts(START, r) });
  }
  const usedIn = new Set(P.products.map((p) => p[4]));
  const usedOut = new Set([...P.suppliers.map((s) => s[4]), 'salaires', 'impots', 'banque', 'materiel']);
  for (const dir of ['in', 'out']) {
    for (const [k, [label, acode]] of Object.entries(catDefs[dir])) {
      if (!(dir === 'in' ? usedIn : usedOut).has(k)) continue;
      const id = ids('categories'), gid = dir === 'in' ? grpIn : grpOut;
      cats[dir][k] = { id, label, gid, acode, direction: dir === 'in' ? 'cash_in' : 'cash_out', created: ts(START, r), updated: ts(START, r) };
      const v = { id, label, direction: cats[dir][k].direction, analytical_code: acode, created_at: cats[dir][k].created, updated_at: cats[dir][k].updated, archived_at: null, category_group: { id: gid } };
      add('categories', v);
      add('category_groups__categories', v, gid);
    }
  }
  const catOf = (k) => cats.in[k] ?? cats.out[k];
  const catRef = (k, weight = '1.0') => { const c = catOf(k); return { id: c.id, label: c.label, weight, category_group: { id: c.gid }, analytical_code: c.acode, created_at: c.created, updated_at: c.updated }; };

  // Exercices
  FY.forEach((f, i) => {
    const closed = f.finish < NOW;
    add('fiscal_years', { id: ids('fiscal_years'), start: i === 0 ? START : f.start, finish: f.finish, status: closed ? 'closed' : 'open', created_at: ts(f.start, r), updated_at: ts(closed ? addDays(f.finish, 60) : f.start, r) });
  });
  const fyStartOf = (d) => FY.find((f) => d >= f.start && d <= f.finish);

  // ── Tiers ──────────────────────────────────────────────────────────────────────────────────
  const street = ['rue de la République', 'avenue Jean Jaurès', 'cours Gambetta', 'rue Victor Hugo', 'boulevard des Belges', 'quai Saint-Antoine', 'rue de la Part-Dieu', 'chemin des Vignes', 'place Bellecour', 'rue Garibaldi'];
  const addr = (city, cp) => ({ address: `${r.int(2, 140)} ${r.pick(street)}`, postal_code: cp, city, country_alpha2: 'FR' });
  const firstNames = ['Camille', 'Julien', 'Sophie', 'Nicolas', 'Élodie', 'Romain', 'Aurélie', 'Mathieu', 'Laure', 'Pierre'];
  const lastNames = ['Martin', 'Bernard', 'Dubois', 'Laurent', 'Simon', 'Michel', 'Garcia', 'Lambert', 'Fontaine', 'Roux'];
  const phone = () => `+33${r.pick([4, 6, 7])}${String(r.int(10000000, 99999999))}`;

  const customers = P.customers.map(([name, type, city, cp, cond, late, weight], i) => {
    const id = ids('customers');
    const account = acct(`411${code(name, 5)}`, name, { letterable: true, aux: true });
    const created = `${addDays(START, 3 + i * 4) > NOW ? START : addDays(START, 3 + i * 4)}`;
    const isPerson = type === 'individual';
    const [first, ...rest] = name.split(' ');
    const sir = mkSiren(r);
    const c = { id, name, type, city, cp, cond, late, weight, account, created, first, last: rest.join(' '), sir, email: isPerson ? `${slug(name)}@mail.example` : `compta@${slug(name)}.example`, pay: null };
    const extIdx = String(id).padStart(4, '0');
    const recipient = isPerson ? name : `${r.pick(firstNames)} ${r.pick(lastNames)}`;
    const v = {
      id, name, billing_iban: ibanFR(r), payment_conditions: cond, recipient, phone: phone(), reference: `CLI-${extIdx}`,
      notes: i === 0 ? 'Client historique — contact principal : direction générale.' : null,
      vat_number: isPerson ? null : frVat(sir), reg_no: isPerson ? null : sir,
      ledger_account: aRefId(account), emails: [c.email], billing_address: addr(city, cp), delivery_address: addr(city, cp),
      created_at: ts(created, r), updated_at: ts(created, r), customer_type: type, external_reference: `cus-${P.id}-${extIdx}`, billing_language: 'fr_FR',
      mandates: { url: url(`/gocardless_mandates?filter=${encodeURIComponent(JSON.stringify([{ field: 'customer_id', operator: 'eq', value: String(id) }]))}`) },
      pro_account_mandates: { url: url(`/pro_account/mandates?filter=${encodeURIComponent(JSON.stringify([{ field: 'customer_id', operator: 'eq', value: String(id) }]))}`) },
      contacts: { url: url(`/customers/${id}/contacts`) },
    };
    if (isPerson) { Object.assign(v, { first_name: c.first, last_name: c.last }); delete v.vat_number; delete v.reg_no; }
    c.values = v;
    return c;
  });
  // La liste /customers est un mélange de sociétés et de particuliers : on rend chaque type avec son gabarit détail.
  for (const c of customers) {
    const item = render('customers', c.values);
    if (c.type === 'individual') { delete item.vat_number; delete item.reg_no; item.first_name = c.first; item.last_name = c.last; }
    (C.customers ??= []).push({ ...item, _company: P.id });
    const cn = c.type === 'individual' ? 1 : r.int(1, 2);
    for (let k = 0; k < cn; k++) {
      const cid = ids('customers__contacts');
      const f = r.pick(firstNames), l = r.pick(lastNames);
      add('customers__contacts', { id: cid, first_name: f, last_name: l, role: r.pick(['accountant', 'manager', 'other']), email: `${slug(f)}.${slug(l)}@${slug(c.name)}.example`, telephone_number: phone(), mobile_number: phone(), created_at: ts(c.created, r), updated_at: ts(c.created, r) }, c.id);
    }
  }

  const suppliers = P.suppliers.map(([name, acc, accLabel, vat, cat, rec, range, kind], i) => {
    const id = ids('suppliers');
    const sir = name === FIRM_NAME ? '552081317' : mkSiren(r);
    const account = acct(`401${code(name, 5)}`, name, { letterable: true, aux: true });
    const charge = acct(acc, accLabel);
    const auto = !!rec && ['loyer', 'assurance', 'telecom', 'saas', 'energie'].includes(cat);
    const s = { id, name, acc: charge, vat: hasVat ? vat : 'exempt', cat, rec, range, kind, account, auto, sir, code: code(name, 2), created: addDays(START, i), delay: auto ? 0 : 30 };
    add('suppliers', {
      id, name, establishment_no: mkSiret(sir, 1), reg_no: sir, vat_number: frVat(sir), ledger_account: aRefId(account), emails: [`facturation@${slug(name)}.example`],
      iban: ibanFR(r), postal_address: addr(r.pick(['Lyon', 'Paris', 'Villeurbanne', 'Nantes']), r.pick(['69003', '75008', '69100', '44000'])),
      supplier_payment_method: kind === 'bank' ? 'automatic_debiting' : auto ? 'automatic_debiting' : 'manual_transfer', supplier_due_date_delay: s.delay, supplier_due_date_rule: 'days',
      external_reference: `sup-${P.id}-${String(id).padStart(4, '0')}`, created_at: ts(s.created, r), updated_at: ts(s.created, r),
    });
    const cid = cat;
    add('suppliers__categories', catRef(cid), id);
    return s;
  });
  const bankSupplier = suppliers.find((s) => s.kind === 'bank');

  const salesAcc = acct(P.salesAccount ?? '706');
  const products = P.products.map(([label, unit, price, vat, cat], i) => {
    const id = ids('products');
    const p = { id, label, unit, price: Math.round(price * 100), vat, cat, desc: `${label} — prestation référencée au catalogue.` };
    add('products', {
      id, label, description: p.desc, external_reference: `prd-${P.id}-${String(id).padStart(3, '0')}`,
      price_before_tax: (p.price / 100).toFixed(2), vat_rate: vat, price: ((p.price * (1 + VAT[vat])) / 100).toFixed(2), unit, currency: 'EUR', reference: `PRD-${String(i + 1).padStart(3, '0')}`,
      substance: salesAcc.number === '701' ? 'goods' : 'services', ledger_account: aRefId(salesAcc), archived_at: null, created_at: ts(START, r), updated_at: ts(START, r), custom_fields: [],
    });
    return p;
  });

  // ── Moteur d'écritures ─────────────────────────────────────────────────────────────────────
  const entries = [];
  const lineIndex = {}; // id -> ligne
  let letterSeq = 0;
  const VALIDATION_FROM = addDays(NOW, -45);
  function postEntry({ date, j, label, piece = null, due = null, invoiceNumber = null, lines, status = 'complete', file = null, cats: ecats = [], stamp }) {
    const id = ids('ledger_entries');
    const d = lines.reduce((s, l) => s + (l.d ?? 0), 0), c = lines.reduce((s, l) => s + (l.c ?? 0), 0);
    if (status !== 'draft' && (d !== c || d === 0)) throw new Error(`écriture déséquilibrée ${label} ${date}: D=${d} C=${c}`);
    const created = stamp ?? ts(date, r);
    const e = { id, date, j, label, lines: [] };
    for (const l of lines) {
      const lid = ids('ledger_entry_lines');
      const line = { id: lid, entry: e, acct: l.acct, d: l.d ?? 0, c: l.c ?? 0, label: l.label ?? label, cats: l.cats ?? [], group: null, created };
      e.lines.push(line); lineIndex[lid] = line;
    }
    entries.push(e);
    const att = file ? { filename: file, url: `${HOST}/rails/active_storage/blobs/redirect/${b64(`entry:${id}`)}/${encodeURIComponent(file)}` } : null;
    add('ledger_entries', { id, created_at: created, updated_at: created, label, piece_number: piece, date, due_date: due, invoice_number: invoiceNumber, journal_id: journals[j].id, journal: jref(j), status: ['OD', 'AN'].includes(j) ? null : status, categories: ecats, ledger_attachment_filename: file, attachment: att, ledger_entry_lines: [] });
    e.item = C.ledger_entries?.at(-1);
    if (file) add('ledger_entries__dms_files', { id: ids('ledger_entries__dms_files'), name: file, url: att.url, created_at: created, updated_at: created }, id);
    e.created = created;
    return e;
  }
  const letter = (...lines) => { const g = ++letterSeq; lines.forEach((l) => ((l.carriedTo ?? l).group = g)); };

  // ── Factures clients ───────────────────────────────────────────────────────────────────────
  const invoices = [], quotes = [], supplierInvoices = [], transactions = [];
  const events = []; // règlements à venir : { date, run() }
  const pdfUrl = (kind, id) => `${HOST}/public/invoice/pdf?encrypted_id=${encodeURIComponent(b64(`${kind}:${id}`))}`;
  let taxCollected = {}, taxDeductible = {}; // par mois
  const bump = (m, k, v) => (m[k] = (m[k] ?? 0) + v);

  function computeLines(items) {
    return items.map(({ product, qty, disc = 0, label }) => {
      const gross = product.price * qty;
      const ht = round(gross * (1 - disc / 100));
      const tax = round(ht * VAT[product.vat]);
      return { product, qty, disc, label: label ?? product.label, ht, tax, ttc: ht + tax, unit: round(product.price) };
    });
  }
  const lineValues = (l, created, sectionRank = null, withProduct = true) => ({
    label: l.label, unit: l.product.unit, quantity: String(l.qty), amount: money(l.ttc), currency_amount: money(l.ttc),
    description: l.product.desc, product: withProduct ? ref('products', l.product.id) : null, vat_rate: l.product.vat, currency_amount_before_tax: money(l.ht),
    currency_tax: money(l.tax), tax: money(l.tax), raw_currency_unit_price: money(l.unit), discount: { type: 'relative', value: String(l.disc) },
    section_rank: sectionRank, imputation_dates: null, created_at: created, updated_at: created, substance: salesAcc.number === '701' ? 'goods' : 'services', custom_fields: [],
  });
  const tot = (lines) => lines.reduce((a, l) => ({ ht: a.ht + l.ht, tax: a.tax + l.tax, ttc: a.ttc + l.ttc }), { ht: 0, tax: 0, ttc: 0 });

  function createCustomerInvoice({ date, customer, items, quoteId = null, subscription = null, sections = false, credit = null, draft = false, subject }) {
    const id = ids('customer_invoices');
    const sign = credit ? -1 : 1;
    const ls = computeLines(items);
    const T = tot(ls);
    const number = draft ? '' : credit ? `A-${date.slice(0, 4)}-${date.slice(5, 7)}-${String(nextNo('credit_note')).padStart(4, '0')}` : `F-${date.slice(0, 4)}-${date.slice(5, 7)}-${String(nextNo('invoice')).padStart(4, '0')}`;
    const deadline = credit ? date : dueDate(date, customer.cond);
    const created = ts(date, r);
    const inv = { id, date, deadline, customer, lines: ls, T, sign, number, credit, draft, paid: 0, id0: id, created, quoteId, subscription, payments: [], entry: null, cat: [...new Set(ls.map((l) => l.product.cat))] };
    if (draft) inv.entry = postEntry({ date, j: 'VT', label: `Brouillon - ${customer.name}`, lines: [], status: 'draft' });
    if (!draft) {
      const revLines = ls.map((l) => ({ acct: salesAcc, [sign > 0 ? 'c' : 'd']: l.ht, label: l.label, cats: [catRef(l.product.cat)] })).filter((l) => l.c || l.d);
      const vatByRate = {};
      ls.forEach((l) => l.tax && (vatByRate[l.product.vat] = (vatByRate[l.product.vat] ?? 0) + l.tax));
      const vatLines = Object.values(vatByRate).map((t) => ({ acct: accts[44571], [sign > 0 ? 'c' : 'd']: t, label: `TVA collectée - ${number}` }));
      const recv = { acct: customer.account, [sign > 0 ? 'd' : 'c']: T.ttc, label: `${customer.name} - ${number}` };
      inv.entry = postEntry({ date, j: 'VT', label: `${credit ? 'Avoir' : 'Facture'} ${number} - ${customer.name}`, piece: number, due: deadline, invoiceNumber: number, lines: [recv, ...revLines, ...vatLines], file: `${number}.pdf`, cats: [...new Set(ls.map((l) => l.product.cat))].map((k) => catRef(k)) });
      inv.recvLine = inv.entry.lines[0];
      T.tax && bump(taxCollected, date.slice(0, 7), sign * T.tax);
    }
    invoices.push(inv);
    return inv;
  }

  // Facturation : règlements planifiés (complets, partiels ou absents)
  function planPayment(inv) {
    if (inv.draft || inv.credit || inv.cancelled) return;
    const c = inv.customer;
    let pay = nextWorkday(addDays(inv.deadline, c.late + r.int(-2, 3)));
    if (pay < inv.date) pay = nextWorkday(inv.date);
    const partial = r.chance(0.07) && inv.T.ttc > 100000;
    const chunks = partial ? [round(inv.T.ttc * 0.5), inv.T.ttc - round(inv.T.ttc * 0.5)] : [inv.T.ttc];
    chunks.forEach((amount, i) => {
      const d = i === 0 ? pay : nextWorkday(addDays(pay, r.int(18, 32)));
      if (d > NOW) return;
      events.push({ date: d, run: () => payCustomerInvoice(inv, amount, d) });
    });
  }

  function payCustomerInvoice(inv, amount, date) {
    const c = inv.customer;
    const label = `VIR SEPA ${c.name.toUpperCase()} ${inv.number}`;
    const tx = createTransaction({ date, label, amount, customer: c, matched: [{ type: 'customer', inv }], cat: inv.cat, counter: { acct: c.account, label: `${c.name} - ${inv.number}` }, sign: 1 });
    inv.paid += amount;
    inv.payments.push({ amount, date, tx });
    if (inv.paid === inv.T.ttc) {
      letter(inv.recvLine, ...inv.payments.map((p) => p.tx.entryCounterLine));
    }
  }

  // Transaction bancaire + écriture du journal de banque
  let bankBalance = 0;
  function createTransaction({ date, label, amount, customer = null, supplier = null, matched = [], cat = [], counter, sign, attachmentRequired = null, file = null }) {
    const id = ids('transactions');
    bankBalance += sign * amount;
    const created = ts(date, r, 6);
    const lines = sign > 0
      ? [{ acct: bankAcctL, d: amount, label }, { acct: counter.acct, c: amount, label: counter.label }]
      : [{ acct: counter.acct, d: amount, label: counter.label }, { acct: bankAcctL, c: amount, label }];
    const catsArr = cat.map((k) => catRef(k));
    const entry = postEntry({ date, j: 'BQ1', label, lines: lines.map((l) => (counter.cats && l.acct === counter.acct ? { ...l, cats: counter.cats.map((k) => catRef(k)) } : l)), stamp: created, cats: catsArr, file });
    const tx = { id, date, label, amount: sign * amount, entry, customer, supplier, balance: bankBalance, matched };
    tx.entryCounterLine = entry.lines[sign > 0 ? 1 : 0];
    transactions.push(tx);
    const v = {
      id, label, attachment_required: attachmentRequired ?? (matched.length === 0 && !!supplier), date, outstanding_balance: money(bankBalance), created_at: created, updated_at: created, archived_at: null,
      currency: 'EUR', currency_amount: money(sign * amount), amount: money(sign * amount), currency_fee: null, fee: null, journal: jref('BQ1'), bank_account: ref('bank_accounts', bankAcct.id),
      pro_account_expense: null, customer: customer ? ref('customers', customer.id) : null, supplier: supplier ? ref('suppliers', supplier.id) : null, categories: catsArr,
      matched_invoices: { url: url(`/transactions/${id}/matched_invoices`) }, interbank_code: null,
    };
    add('transactions', v);
    catsArr.forEach((c) => add('transactions__categories', c, id));
    matched.forEach((m) => {
      const inv = m.inv;
      add('transactions__matched_invoices', { id: inv.id, type: m.type, url: url(`/${m.type === 'customer' ? 'customer_invoices' : 'supplier_invoices'}/${inv.id}`) }, id);
      (inv.matchedTx ??= []).push(tx);
    });
    return tx;
  }

  // ── Boucle mensuelle ───────────────────────────────────────────────────────────────────────
  const plannedFromQuote = {};
  const assets = []; // immobilisations à amortir
  let vatCredit = 0;
  let cancelTarget = null;
  const subscriptions = [];
  const custWeighted = customers.flatMap((c) => Array(c.weight).fill(c));
  const pickProducts = (c) => {
    const n = r.chance(0.35) ? 2 : 1;
    const pool = c.type === 'individual' ? products.filter((p) => p.price < 120000) : products.filter((p) => p.unit !== 'month');
    return r.shuffle(pool).slice(0, n).map((product) => ({
      product, qty: product.unit === 'day' ? r.int(1, 6) : product.unit === 'piece' ? (product.price < 5000 ? r.int(30, 160) : product.price < 10000 ? r.int(2, 14) : product.price < 40000 ? r.int(2, 8) : r.int(1, 3)) : 1, disc: r.chance(0.12) ? r.pick([5, 10]) : 0,
    }));
  };

  // abonnements de facturation (sur les produits "mensuels"/"annuels" du catalogue)
  const subProducts = products.filter((p) => ['month', 'year'].includes(p.unit));
  if (subProducts.length && customers.length > 4) {
    [[customers[0], subProducts.find((p) => p.unit === 'month')], [customers[5], subProducts.find((p) => p.unit === 'year')]].forEach(([c, p], i) => {
      if (!p) return;
      subscriptions.push({ id: ids('billing_subscriptions'), customer: c, product: p, day: i === 0 ? 5 : 12, every: p.unit === 'year' ? 12 : 1, start: addMonths(START, i + 1), last: null });
    });
  }

  let firstInvoiceDone = false;
  for (const m of allMonths) {
    const monthStartD = `${m}-01`, monthEnd = endOfMonth(monthStartD);
    const isFirst = m === START.slice(0, 7);
    // Reports à nouveau : on entame l'exercice 2026
    if (FY.length > 1 && m === '2026-01' && !isFirst) carryForward('2026-01-01');
    if (isFirst) {
      // dépôt du capital social
      createTransaction({ date: START, label: 'VIR CAPITAL SOCIAL - LIBERATION', amount: P.capital, counter: { acct: accts[1013], label: 'Capital social libéré' }, sign: 1, attachmentRequired: false });
    }

    // — devis (clients) —
    if (!isFirst && P.customers.length > 5 && r.chance(0.7)) {
      const c = r.pick(custWeighted);
      const d = clampDay(m, r.int(3, 20));
      const items = pickProducts(c);
      const outcome = r.pick(['invoiced', 'invoiced', 'accepted', 'denied', 'expired', 'pending']);
      const q = createQuote({ date: d, customer: c, items, status: d > addDays(NOW, -20) ? 'pending' : outcome });
      if (q.status === 'invoiced') (plannedFromQuote[addMonths(d, 1).slice(0, 7)] ??= []).push(q);
    }

    // — factures clients —
    const n = r.int(...P.target.perMonth) - (isFirst ? 1 : 0);
    const plans = (plannedFromQuote[m] ?? []).map((q) => ({ customer: q.customer, items: q.items, quote: q }));
    for (let i = plans.length; i < n; i++) {
      const c = r.pick(custWeighted);
      plans.push({ customer: c, items: pickProducts(c) });
    }
    plans.forEach((pl, i) => {
      const date = nextWorkday(clampDay(m, pl.quote ? r.int(2, 12) : Math.min(28, 4 + i * r.int(4, 8) + r.int(0, 3))));
      if (date > NOW) return;
      const inv = createCustomerInvoice({ date, customer: pl.customer, items: pl.items, quoteId: pl.quote?.id ?? null, sections: r.chance(0.2), draft: false });
      if (pl.quote) { pl.quote.invoice = inv; }
      // un avoir total sur une facture de mai/juin 2025
      if (!cancelTarget && /^2025-0[5-6]/.test(date) && inv.T.ttc > 100000) {
        cancelTarget = inv; inv.cancelled = true;
        const cd = nextWorkday(addDays(date, 9));
        const cn = createCustomerInvoice({ date: cd, customer: inv.customer, items: inv.lines.map((l) => ({ product: l.product, qty: l.qty, disc: l.disc, label: l.label })), credit: inv });
        inv.creditNote = cn;
        letter(inv.recvLine, cn.recvLine);
      } else planPayment(inv);
      firstInvoiceDone = true;
    });
    // abonnements récurrents
    subscriptions.forEach((s) => {
      if (m < s.start.slice(0, 7)) return;
      const k = months(s.start, m).length - 1;
      if (k % s.every !== 0) return;
      const date = nextWorkday(clampDay(m, s.day));
      if (date > NOW) return;
      const inv = createCustomerInvoice({ date, customer: s.customer, items: [{ product: s.product, qty: 1 }], subscription: s });
      s.last = date;
      planPayment(inv);
    });
    // brouillon en cours (mois courant)
    if (m === NOW.slice(0, 7) && customers.length > 3) {
      const c = customers[3]; createCustomerInvoice({ date: NOW, customer: c, items: pickProducts(c), draft: true });
    }

    // — factures fournisseurs —
    const supplierPlans = [];
    suppliers.forEach((s) => {
      if (s.kind === 'bank') return;
      if (s.rec) {
        if (s.rec.quarterly && !['03', '06', '09', '12'].includes(m.slice(5))) return;
        supplierPlans.push({ s, date: nextWorkday(clampDay(m, s.rec.day)), amount: Math.round(s.rec.amount * 100) * (s.rec.quarterly ? 3 : 1), label: s.rec.label, noVat: s.rec.vat === 'none' });
      }
    });
    const extra = suppliers.filter((s) => !s.rec && s.kind !== 'bank' && s.range !== 'capex');
    const nExtra = r.int(...P.target.supplierPerMonth) - 1;
    for (let i = 0; i < Math.max(0, nExtra) && extra.length; i++) {
      const s = r.pick(extra);
      const [lo, hi] = s.range;
      supplierPlans.push({ s, date: nextWorkday(clampDay(m, r.int(3, 27))), amount: r.int(lo * 100, hi * 100), label: s.acc.label });
    }
    const capex = suppliers.find((s) => s.range === 'capex');
    if (capex && (isFirst || (m === '2026-03' && P.id === 101))) supplierPlans.push({ s: capex, date: nextWorkday(clampDay(m, isFirst ? 9 : 17)), amount: isFirst ? 215000 : 189000, label: isFirst ? 'MacBook Pro 14" — poste graphisme' : 'Écran 27" 4K & station d\'accueil', capex: true });
    supplierPlans.sort((a, b) => a.date.localeCompare(b.date)).forEach((pl) => {
      if (pl.date > NOW || (pl.date < START)) return;
      createSupplierInvoice(pl);
    });
    // — frais bancaires (prélevés directement) —
    if (bankSupplier && !isFirst) {
      const d = nextWorkday(clampDay(m, 2));
      if (d <= NOW) events.push({ date: d, run: () => createTransaction({ date: d, label: 'PRLV FRAIS TENUE DE COMPTE ET CARTE', amount: r.int(1450, 1980), supplier: bankSupplier, counter: { acct: accts[627], label: 'Frais bancaires', cats: ['banque'] }, sign: -1, attachmentRequired: false, cat: ['banque'] }) });
    }

    // — paie —
    if (P.employees && !(m === START.slice(0, 7) && P.id === 101)) {
      const gross = P.employees.gross, patronal = round(gross * 0.42), net = round(gross * 0.78), social = gross + patronal - net;
      const d = nextWorkday(monthEnd > NOW ? NOW : monthEnd);
      const label = `Paie ${m.slice(5)}/${m.slice(0, 4)}`;
      const pe = postEntry({ date: d, j: 'OD', label, piece: `PAIE-${m}`, lines: [{ acct: accts[641], d: gross, cats: [catRef('salaires')] }, { acct: accts[645], d: patronal, cats: [catRef('salaires')] }, { acct: accts[421], c: net }, { acct: accts[431], c: social }], status: 'complete', cats: [catRef('salaires')] });
      const netLine = pe.lines[2], socLine = pe.lines[3];
      const payD = nextWorkday(d);
      if (payD <= NOW) events.push({ date: payD, run: () => { const t = createTransaction({ date: payD, label: `VIR SALAIRES ${m.slice(5)}/${m.slice(0, 4)}`, amount: net, counter: { acct: accts[421], label: label }, sign: -1, attachmentRequired: false }); letter(netLine, t.entryCounterLine); } });
      const urssafD = nextWorkday(clampDay(addMonths(`${m}-01`, 1).slice(0, 7), 15));
      if (urssafD <= NOW) events.push({ date: urssafD, run: () => { const t = createTransaction({ date: urssafD, label: `PRLV URSSAF ${m.slice(5)}/${m.slice(0, 4)}`, amount: social, counter: { acct: accts[431], label: `Cotisations ${label}` }, sign: -1, attachmentRequired: false, cat: ['salaires'] }); letter(socLine, t.entryCounterLine); } });
    }
    // — amortissements —
    for (const a of assets) {
      if (m > a.from && months(a.from, m).length - 1 <= 36) {
        const dd = nextWorkday(monthEnd > NOW ? NOW : monthEnd);
        postEntry({ date: dd, j: 'OD', label: `Dotation aux amortissements ${m} — ${a.label}`, piece: `AMORT-${m}`, lines: [{ acct: accts[6811], d: a.monthly, cats: [catRef('materiel')] }, { acct: accts[28183], c: a.monthly }], status: 'complete' });
      }
    }
    // — TVA —
    if (hasVat) {
      const quarterly = P.vat_frequency === 'quarterly';
      const closing = quarterly ? ['03', '06', '09', '12'].includes(m.slice(5)) : true;
      if (closing) {
        const periodMonths = quarterly ? [m, addMonths(`${m}-01`, -1).slice(0, 7), addMonths(`${m}-01`, -2).slice(0, 7)] : [m];
        const coll = periodMonths.reduce((s, k) => s + (taxCollected[k] ?? 0), 0), ded = periodMonths.reduce((s, k) => s + (taxDeductible[k] ?? 0), 0);
        if (coll || ded) {
          const dd = nextWorkday(monthEnd > NOW ? NOW : monthEnd);
          const net = coll - ded - vatCredit;
          const lines = [];
          if (coll > 0) lines.push({ acct: accts[44571], d: coll, label: 'TVA collectée' });
          if (coll < 0) lines.push({ acct: accts[44571], c: -coll });
          if (ded > 0) lines.push({ acct: accts[44566], c: ded, label: 'TVA déductible' });
          if (vatCredit > 0) lines.push({ acct: accts[44567], c: vatCredit, label: 'Report du crédit de TVA' });
          let payLine = null;
          if (net > 0) lines.push((payLine = { acct: accts[44551], c: net, label: 'TVA à décaisser' }));
          if (net < 0) lines.push({ acct: accts[44567], d: -net, label: 'Crédit de TVA à reporter' });
          const ve = postEntry({ date: dd, j: 'OD', label: `Déclaration de TVA ${m}`, piece: `TVA-${m}`, lines, status: 'complete' });
          vatCredit = net < 0 ? -net : 0;
          if (net > 0) {
            const payDate = nextWorkday(clampDay(addMonths(`${m}-01`, 1).slice(0, 7), P.vat_day_of_month ?? 21));
            const vline = ve.lines.find((l) => l.acct === accts[44551]);
            if (payDate <= NOW) events.push({ date: payDate, run: () => { const t = createTransaction({ date: payDate, label: `PRLV DGFIP TVA ${m}`, amount: net, counter: { acct: accts[44551], label: `TVA ${m}` }, sign: -1, attachmentRequired: false, cat: [] }); letter(vline, t.entryCounterLine); } });
          }
        }
      }
    }
    // — règlements du mois, dans l'ordre chronologique —
    events.filter((e) => e.date.slice(0, 7) === m).sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => e.run());
  }

  // Dates de création : un tiers est créé peu avant sa première utilisation (jamais après sa première facture)
  const touch = (list, key, first) => {
    const created = first < addDays(START, 1) ? START : addDays(first, -r.int(1, 6)) < START ? START : addDays(first, -r.int(1, 6));
    const item = C[key].find((x) => x.id === list.id);
    item.created_at = ts(created, r);
    item.updated_at = ts(created, r);
    list.created = created;
    return created;
  };
  customers.forEach((cu) => {
    const dates = [...invoices.filter((i) => i.customer === cu).map((i) => i.date), ...quotes.filter((q) => q.customer === cu).map((q) => q.date)].sort();
    if (!dates.length) return;
    const created = touch(cu, 'customers', dates[0]);
    (C.customers__contacts ?? []).filter((x) => x._parent === cu.id).forEach((x) => { x.created_at = ts(created, r); x.updated_at = x.created_at; });
  });
  suppliers.forEach((su) => {
    const dates = [...supplierInvoices.filter((i) => i.s === su).map((i) => i.date), ...transactions.filter((t) => t.supplier === su).map((t) => t.date)].sort();
    if (dates.length) touch(su, 'suppliers', dates[0]);
  });

  // ── Fonctions appelées depuis la boucle (hoistées) ─────────────────────────────────────────
  function createQuote({ date, customer, items, status }) {
    const id = ids('quotes');
    const ls = computeLines(items);
    const T = tot(ls);
    const number = `D-${date.slice(0, 4)}-${date.slice(5, 7)}-${String(nextNo('estimate')).padStart(4, '0')}`;
    const created = ts(date, r);
    const q = { id, date, customer, items, T, number, status, lines: ls, created };
    quotes.push(q);
    return q;
  }
  function createSupplierInvoice({ s, date, amount, label, noVat, capex }) {
    const id = ids('supplier_invoices');
    const vatRate = noVat ? 'exempt' : s.vat;
    const ht = amount, tax = round(ht * VAT[vatRate]), ttc = ht + tax;
    const number = `${s.code}-${date.slice(0, 4)}-${String(r.int(100, 9999)).padStart(4, '0')}`;
    const deadline = s.auto ? date : addDays(date, s.delay);
    const recent = date >= VALIDATION_FROM;
    const status = recent ? 'validation_needed' : 'complete';
    const created = ts(date, r);
    const inv = { id, s, date, deadline, ht, tax, ttc, number, label, paid: 0, payments: [], created, status, vatRate };
    const debit = capex ? accts[2183] : s.acc;
    const lines = [{ acct: s.account, c: ttc, label: `${s.name} - ${number}` }, { acct: debit, d: ht, label, cats: [catRef(s.cat)] }];
    if (tax) lines.push({ acct: accts[44566], d: tax, label: `TVA déductible - ${number}` });
    inv.entry = postEntry({ date, j: 'AC', label: `${s.name} - ${number}`, piece: number, due: deadline, invoiceNumber: number, lines, status, file: `${number}.pdf`, cats: [catRef(s.cat)], stamp: created });
    inv.payLine = inv.entry.lines[0];
    if (tax) bump(taxDeductible, date.slice(0, 7), tax);
    if (capex) { assets.push({ from: date.slice(0, 7), label, monthly: round(ht / 36) }); }
    supplierInvoices.push(inv);
    // règlement
    const payDate = nextWorkday(s.auto ? deadline : addDays(deadline, r.int(-3, 6)));
    if (payDate <= NOW && !(recent && r.chance(0.5) && !s.auto)) {
      events.push({ date: payDate, run: () => {
        const t = createTransaction({ date: payDate, label: `${s.auto ? 'PRLV SEPA' : 'VIR SEPA EMIS'} ${s.name.toUpperCase()} ${number}`, amount: ttc, supplier: s, matched: [{ type: 'supplier', inv }], cat: [s.cat], counter: { acct: s.account, label: `${s.name} - ${number}` }, sign: -1 });
        inv.paid = ttc; inv.payments.push({ amount: ttc, date: payDate, tx: t });
        letter(inv.payLine, t.entryCounterLine);
      } });
    }
    return inv;
  }
  function carryForward(date) {
    const prev = `${Number(date.slice(0, 4)) - 1}-12-31`;
    const bal = {};
    const open = [];
    let pl = 0;
    for (const e of entries) for (const l of e.lines) {
      if (e.date > prev) continue;
      const a = l.acct, n = l.d - l.c;
      if (Number(a.number[0]) >= 6) pl += n;
      else if (a.letterable) { if (!l.group) open.push(l); }
      else { bal[a.number] ??= { a, v: 0 }; bal[a.number].v += n; }
    }
    const lines = [];
    const src = [];
    open.forEach((l) => { lines.push(l.d ? { acct: l.acct, d: l.d, label: l.label } : { acct: l.acct, c: l.c, label: l.label }); src.push(l); });
    Object.values(bal).filter((x) => x.v !== 0).forEach(({ a, v }) => { lines.push(v > 0 ? { acct: a, d: v, label: 'Report à nouveau' } : { acct: a, c: -v, label: 'Report à nouveau' }); src.push(null); });
    if (pl < 0) { lines.push({ acct: accts[120], c: -pl, label: 'Résultat de l\'exercice précédent' }); src.push(null); }
    if (pl > 0) { lines.push({ acct: accts[129], d: pl, label: 'Résultat de l\'exercice précédent' }); src.push(null); }
    const e = postEntry({ date, j: 'AN', label: 'Reprise des à nouveaux', piece: `AN-${date.slice(0, 4)}`, lines, status: 'complete' });
    // une ligne reportée garde la trace de son origine : le lettrage futur porte sur la ligne d'à-nouveau
    e.lines.forEach((l, i) => { if (src[i]) src[i].carriedTo = l; });
  }

  // ── Rendu des factures / devis / documents ─────────────────────────────────────────────────
  const status = (inv) => {
    if (inv.draft) return 'draft';
    if (inv.credit) return 'credit_note';
    if (inv.cancelled) return 'cancelled';
    if (inv.paid >= inv.T.ttc) return 'paid';
    if (inv.paid > 0) return 'partially_paid';
    return inv.deadline < NOW ? 'late' : 'upcoming';
  };
  const fix = (n) => (n === 0 ? '0.00' : money(n));
  const numberings = { invoice: ['F-%Y-%m-', 'invoice'], credit_note: ['A-%Y-%m-', 'credit_note'], estimate: ['D-%Y-%m-', 'estimate'] };
  const templateId = ids('customer_invoice_templates');
  add('customer_invoice_templates', { id: templateId, name: 'Modèle standard', created_at: ts(START, r), updated_at: ts(START, r) });
  const quoteTpl = ids('customer_invoice_templates');
  add('customer_invoice_templates', { id: quoteTpl, name: 'Modèle devis', created_at: ts(START, r), updated_at: ts(START, r) });

  invoices.forEach((inv, idx) => {
    const { id, T, sign } = inv;
    const st = status(inv);
    const rem = inv.draft ? null : Math.max(0, inv.T.ttc * sign - inv.paid * sign) * (inv.credit || inv.cancelled ? 0 : 1);
    const remHT = rem === null ? null : round(rem / (1 + (T.ht ? T.tax / T.ht : 0)));
    const hasSection = inv.lines.length > 1 && idx % 5 === 0;
    inv.lines.forEach((l) => add('customer_invoices__invoice_lines', { id: ids('customer_invoices__invoice_lines'), ...lineValues({ ...l, ht: sign * l.ht, tax: sign * l.tax, ttc: sign * l.ttc }, inv.created, hasSection ? 1 : null) }, id));
    if (hasSection) add('customer_invoices__invoice_line_sections', { id: ids('customer_invoices__invoice_line_sections'), title: 'Prestations', description: null, rank: 1, created_at: inv.created, updated_at: inv.created }, id);
    inv.cat.forEach((k) => add('customer_invoices__categories', catRef(k, (1 / inv.cat.length).toFixed(1)), id));
    (inv.matchedTx ?? []).forEach((tx) => add('customer_invoices__matched_transactions', C.transactions.find((t) => t.id === tx.id), id));
    const paidTx = inv.payments.map((p) => p.tx);
    // règlements via mandat GoCardless (client n° 5)
    if (inv.customer === customers[4] && inv.payments.length) inv.payments.forEach((p) => add('customer_invoices__payments', { id: ids('customer_invoices__payments'), label: `Prélèvement ${inv.number}`, currency: 'EUR', currency_amount: money(p.amount), status: 'paid_out', created_at: ts(p.date, r), updated_at: ts(p.date, r) }, id));
    if (idx % 37 === 3 && !inv.draft && !inv.credit) add('customer_invoices__appendices', { id: ids('customer_invoices__appendices'), url: `${HOST}/rails/active_storage/blobs/redirect/${b64('appendix:' + id)}/cahier-des-charges.pdf`, filename: 'cahier-des-charges.pdf', created_at: inv.created, updated_at: inv.created }, id);
    if (idx % 29 === 5 && !inv.draft) add('customer_invoices__custom_header_fields', { id: ids('customer_invoices__custom_header_fields'), title: 'customer_reference', value: `BC-${inv.date.slice(0, 4)}-${String(id).padStart(3, '0')}`, rank: 1, created_at: inv.created, updated_at: inv.created }, id);
    const installments = !inv.draft && !inv.credit && inv.T.ttc > 400000 && inv.payments.length ? true : false;
    if (installments) {
      const half = round(inv.T.ttc / 2);
      [[half, addDays(inv.date, 0)], [inv.T.ttc - half, inv.deadline]].forEach(([amt, dl], k) => add('customer_invoices__installments', { id: ids('customer_invoices__installments'), deadline: dl, amount: money(amt), currency_amount: money(amt), currency: 'EUR', remaining_amount_with_tax: inv.paid >= inv.T.ttc ? '0.00' : money(amt), status: inv.paid >= inv.T.ttc ? 'paid' : dl < NOW ? 'late' : 'upcoming', payment_methods: ['transfer'] }, id));
    }
    const sub = inv.subscription;
    const einv = inv.date >= '2026-09-01' && !inv.draft && !inv.credit && idx % 2 === 0 && P.id === 101
      ? { status: paidTx.length ? 'collected' : 'sent', reason: null, flow: { id: `0b${String(id).padStart(6, '0')}-7c1e-4f0a-9d21-5a7e3b1c${String(id).padStart(4, '0')}` } } : null;
    const values = {
      id, label: `${inv.lines[0].label}${inv.lines.length > 1 ? ' et prestations associées' : ''}`, invoice_number: inv.number, currency: 'EUR', amount: money(T.ttc * sign), currency_amount: money(T.ttc * sign), currency_amount_before_tax: money(T.ht * sign), exchange_rate: '1.0',
      date: inv.draft ? null : inv.date, deadline: inv.draft ? null : inv.deadline, currency_tax: money(T.tax * sign), tax: money(T.tax * sign), language: 'fr_FR', paid: st === 'paid', status: st, discount: { type: 'relative', value: '0' },
      ledger_entry: inv.entry ? { id: inv.entry.id, url: url(`/ledger_entries/${inv.entry.id}`) } : null, public_file_url: inv.draft ? null : pdfUrl('customer_invoice', id), filename: inv.draft ? null : `${inv.number}.pdf`,
      remaining_amount_with_tax: rem === null ? null : money(rem), remaining_amount_without_tax: rem === null ? null : money(remHT), draft: inv.draft, special_mention: inv.customer.cond === 'upon_receipt' ? 'Paiement à réception.' : 'En cas de retard, pénalité de 3 fois le taux d\'intérêt légal et indemnité forfaitaire de 40 €.',
      customer: ref('customers', inv.customer.id), payment_method_ledger_account: null,
      invoice_line_sections: { url: url(`/customer_invoices/${id}/invoice_line_sections`) }, invoice_lines: { url: url(`/customer_invoices/${id}/invoice_lines`) }, custom_header_fields: { url: url(`/customer_invoices/${id}/custom_header_fields`) },
      categories: { url: url(`/customer_invoices/${id}/categories`) }, pdf_invoice_free_text: 'Merci de votre confiance.', pdf_invoice_subject: inv.lines[0].label, pdf_description: null,
      billing_subscription: sub ? { id: sub.id } : null, credited_invoice: inv.credit ? ref('customer_invoices', inv.credit.id) : null, customer_invoice_template: { id: templateId },
      transaction_reference: { banking_provider: 'bank', provider_field_name: 'label', provider_field_value: 'invoice_number' },
      payments: { url: url(`/customer_invoices/${id}/payments`) }, matched_transactions: { url: url(`/customer_invoices/${id}/matched_transactions`) }, appendices: { url: url(`/customer_invoices/${id}/appendices`) },
      installments: installments ? { url: url(`/customer_invoices/${id}/installments`) } : null, quote: inv.quoteId ? { id: inv.quoteId } : null,
      external_reference: `inv-${P.id}-${String(id).padStart(5, '0')}`, purchase_order_reference: idx % 29 === 5 ? `BC-${inv.date.slice(0, 4)}-${String(id).padStart(3, '0')}` : null, sales_order_reference: null, e_invoicing: einv,
      factur_x: !!einv, schematron_validation_status: einv ? 'valid' : null, archived_at: null, created_at: inv.created, updated_at: inv.payments.length ? ts(inv.payments.at(-1).date, r) : inv.created,
    };
    add('customer_invoices', values);
  });

  // — devis —
  quotes.forEach((q) => {
    const { id } = q;
    add('quotes', {
      id, label: q.lines[0].label, quote_number: q.number, currency: 'EUR', amount: money(q.T.ttc), currency_amount: money(q.T.ttc), currency_amount_before_tax: money(q.T.ht), exchange_rate: '1.0', date: q.date, deadline: addDays(q.date, 30), currency_tax: money(q.T.tax), tax: money(q.T.tax), language: 'fr_FR', status: q.status,
      discount: { type: 'relative', value: '0' }, public_file_url: pdfUrl('quote', id), filename: `${q.number}.pdf`, special_mention: 'Devis valable 30 jours. Acompte de 30 % à la commande.', customer: ref('customers', q.customer.id),
      invoice_line_sections: { url: url(`/quotes/${id}/invoice_line_sections`) }, invoice_lines: { url: url(`/quotes/${id}/invoice_lines`) },
      linked_invoices: { url: url(`/customer_invoices?filter=${encodeURIComponent(JSON.stringify([{ field: 'quote_id', operator: 'eq', value: id }]))}`) },
      pdf_invoice_free_text: 'Bon pour accord — date et signature.', pdf_invoice_subject: q.lines[0].label, pdf_description: null, quote_template: { id: quoteTpl }, appendices: { url: url(`/quotes/${id}/appendices`) },
      external_reference: `quo-${P.id}-${String(id).padStart(4, '0')}`, archived_at: null, created_at: q.created, updated_at: q.created,
    });
    q.lines.forEach((l) => add('quotes__invoice_lines', { id: ids('quotes__invoice_lines'), ...lineValues(l, q.created) }, id));
    if (id % 4 === 1) add('quotes__invoice_line_sections', { id: ids('quotes__invoice_line_sections'), title: 'Prestations', description: null, rank: 1, created_at: q.created, updated_at: q.created }, id);
    if (id % 6 === 2) add('quotes__appendices', { id: ids('quotes__appendices'), url: `${HOST}/rails/active_storage/blobs/redirect/${b64('qa:' + id)}/brief-projet.pdf`, filename: 'brief-projet.pdf', created_at: q.created, updated_at: q.created }, id);
  });
  // facture liée à un devis "invoiced" : la référence est portée par la facture (quote.id) — cohérence vérifiée dans validate.mjs

  // — documents commerciaux (proforma / BL / bon de commande) —
  if (customers.length > 6) {
    [['proforma', customers[6], 0], ['shipping_order', customers[2], 1], ['purchasing_order', customers[8], 2], ['proforma', customers[10] ?? customers[1], 3]].forEach(([type, c, k]) => {
      const id = ids('commercial_documents');
      const date = addDays(NOW, -40 - k * 37);
      const ls = computeLines([{ product: products[k % products.length], qty: 1 }]);
      const T = tot(ls), created = ts(date, r);
      add('commercial_documents', {
        id, label: `${{ proforma: 'Facture proforma', shipping_order: 'Bon de livraison', purchasing_order: 'Bon de commande' }[type]} — ${c.name}`, document_number: `${{ proforma: 'PF', shipping_order: 'BL', purchasing_order: 'BC' }[type]}-${date.slice(0, 4)}-${String(k + 1).padStart(4, '0')}`, document_type: type, currency: 'EUR',
        amount: money(T.ttc), currency_amount: money(T.ttc), currency_amount_before_tax: money(T.ht), exchange_rate: '1.0', date, deadline: addDays(date, 30), currency_tax: money(T.tax), tax: money(T.tax), language: 'fr_FR', discount: { type: 'relative', value: '0' },
        public_file_url: pdfUrl('commercial_document', id), filename: `${type}-${id}.pdf`, special_mention: null, customer: ref('customers', c.id), invoice_line_sections: { url: url(`/commercial_documents/${id}/invoice_line_sections`) },
        invoice_lines: { url: url(`/commercial_documents/${id}/invoice_lines`) }, quote: null, pdf_invoice_free_text: 'Document à titre indicatif.', pdf_invoice_subject: `${type}`, pdf_description: null, commercial_document_template: { id: templateId },
        appendices: { url: url(`/commercial_documents/${id}/appendices`) }, external_reference: `doc-${P.id}-${id}`, archived_at: null, created_at: created, updated_at: created,
      });
      ls.forEach((l) => add('commercial_documents__invoice_lines', { id: ids('commercial_documents__invoice_lines'), ...lineValues(l, created) }, id));
      add('commercial_documents__invoice_line_sections', { id: ids('commercial_documents__invoice_line_sections'), title: 'Détail', description: null, rank: 1, created_at: created, updated_at: created }, id);
      add('commercial_documents__appendices', { id: ids('commercial_documents__appendices'), url: `${HOST}/rails/active_storage/blobs/redirect/${b64('cd:' + id)}/annexe.pdf`, filename: 'annexe.pdf', created_at: created, updated_at: created }, id);
    });
  }

  // — abonnements —
  subscriptions.forEach((s) => {
    const p = s.product, ls = computeLines([{ product: p, qty: 1 }]), T = tot(ls), created = ts(s.start, r);
    const interval = 1;
    const invs = invoices.filter((i) => i.subscription === s);
    const next = s.every === 12 ? addMonths(s.last ?? s.start, 12) : addMonths(s.last ?? s.start, 1);
    add('billing_subscriptions', {
      id: s.id, next_occurrence: clampDay(next.slice(0, 7), s.day), prev_occurrence: s.last, stopped_at: null, start: s.start, finish: null, status: 'in_progress', mode: 'finalized', activated_at: created,
      payment_conditions: s.customer.cond, payment_method: s === subscriptions[0] ? 'pro_account_sepa_core' : 'offline', label: `${p.label} — ${s.customer.name}`,
      email_settings: { recipients: [s.customer.email], billing_email_template: { id: 1, label: 'Envoi de facture' } },
      recurring_rule: { day_of_month: [s.day], month_of_year: s.every === 12 ? [Number(s.start.slice(5, 7))] : [], week_start: 1, day: [], rule_type: s.every === 12 ? 'yearly' : 'monthly', interval, count: null, until: null },
      customer: ref('customers', s.customer.id),
      customer_invoice_data: { label: p.label, currency: 'EUR', amount: money(T.ttc), currency_amount: money(T.ttc), currency_amount_before_tax: money(T.ht), exchange_rate: '1.0', currency_tax: money(T.tax), language: 'fr_FR', customer_invoice_template: { id: templateId }, discount: { type: 'relative', value: '0' }, pdf_invoice_free_text: 'Merci de votre confiance.', pdf_invoice_subject: p.label, pdf_description: null, special_mention: null, invoice_line_sections: { url: url(`/billing_subscriptions/${s.id}/invoice_line_sections`) }, invoice_lines: { url: url(`/billing_subscriptions/${s.id}/invoice_lines`) } },
      created_at: created, updated_at: ts(s.last ?? s.start, r),
    });
    ls.forEach((l) => add('billing_subscriptions__invoice_lines', { id: ids('billing_subscriptions__invoice_lines'), ...lineValues(l, created) }, s.id));
    add('billing_subscriptions__invoice_line_sections', { id: ids('billing_subscriptions__invoice_line_sections'), title: 'Abonnement', description: null, rank: 1, created_at: created, updated_at: created }, s.id);
    void invs;
  });

  // ── Factures fournisseurs (rendu) ──────────────────────────────────────────────────────────
  supplierInvoices.forEach((inv, idx) => {
    const { id, s } = inv;
    const created = inv.created;
    const rem = inv.ttc - inv.paid;
    const paymentStatus = inv.paid >= inv.ttc ? (s.auto ? 'payment_found' : 'fully_paid') : inv.date >= addDays(NOW, -10) ? 'to_be_processed' : 'to_be_paid';
    const lineBase = { id: ids('supplier_invoices__invoice_lines'), label: inv.label, amount: money(inv.ttc), currency_amount: money(inv.ttc), description: `Facture ${inv.number} — ${s.name}`, vat_rate: inv.vatRate, currency_amount_before_tax: money(inv.ht), currency_tax: money(inv.tax), tax: money(inv.tax), imputation_dates: null, created_at: created, updated_at: created };
    add('supplier_invoices__invoice_lines', lineBase, id);
    add('supplier_invoices__categories', catRef(s.cat), id);
    inv.payments.forEach((p) => add('supplier_invoices__payments', { id: ids('supplier_invoices__payments'), label: `Règlement ${inv.number}`, currency: 'EUR', currency_amount: money(p.amount), status: 'paid_out', created_at: ts(p.date, r), updated_at: ts(p.date, r) }, id));
    (inv.matchedTx ?? []).forEach((tx) => add('supplier_invoices__matched_transactions', C.transactions.find((t) => t.id === tx.id), id));
    add('supplier_invoices', {
      id, label: inv.label, invoice_number: inv.number, currency: 'EUR', amount: money(inv.ttc), currency_amount: money(inv.ttc), currency_amount_before_tax: money(inv.ht), exchange_rate: '1.0', date: inv.date, deadline: inv.deadline, currency_tax: money(inv.tax), tax: money(inv.tax),
      reconciled: inv.paid >= inv.ttc, accounting_status: inv.status, filename: `${inv.number}.pdf`, public_file_url: pdfUrl('supplier_invoice', id), remaining_amount_with_tax: money(rem), remaining_amount_without_tax: money(round(rem / (1 + inv.tax / inv.ht))),
      ledger_entry: { id: inv.entry.id, url: url(`/ledger_entries/${inv.entry.id}`) }, supplier: ref('suppliers', s.id), payment_method_ledger_account: null, invoice_lines: { url: url(`/supplier_invoices/${id}/invoice_lines`) },
      categories: { url: url(`/supplier_invoices/${id}/categories`) }, transaction_reference: { banking_provider: 'bank', provider_field_name: 'label', provider_field_value: 'invoice_number' }, payment_status: paymentStatus, paid: inv.paid >= inv.ttc,
      payments: { url: url(`/supplier_invoices/${id}/payments`) }, matched_transactions: { url: url(`/supplier_invoices/${id}/matched_transactions`) }, external_reference: `sinv-${P.id}-${String(id).padStart(5, '0')}`,
      import_source: idx % 9 === 0 ? { source: 'gdrive', path: `/Compta/Achats/${inv.date.slice(0, 4)}/${inv.number}.pdf` } : null, e_invoicing: null, archived_at: null, created_at: created, updated_at: inv.payments.length ? ts(inv.payments.at(-1).date, r) : created,
    });
  });

  // ── Lignes d'écriture (rendu) : après lettrage pour connaître les groupes ──────────────────
  const groups = {};
  for (const e of entries) for (const l of e.lines) if (l.group) (groups[l.group] ??= []).push(l.id);
  for (const e of entries) {
    e.lines.forEach((l) => {
      const base = {
        id: l.id, debit: money(l.d), credit: money(l.c), label: l.label, categories: l.cats, ledger_account_id: l.acct.id, ledger_account: aRef(l.acct), journal: jref(e.j), date: e.date,
        ledger_entry: { id: e.id, url: url(`/ledger_entries/${e.id}`) }, lettered_ledger_entry_lines: { ids: l.group ? groups[l.group] : [], url: url(`/ledger_entry_lines/${l.id}/lettered_ledger_entry_lines`) }, created_at: l.created, updated_at: l.created,
      };
      add('ledger_entry_lines', base);
      add('ledger_entries__ledger_entry_lines', base, e.id);
      l.cats.forEach((c) => add('ledger_entry_lines__categories', c, l.id));
      if (e.item?.ledger_entry_lines) e.item.ledger_entry_lines.push({ id: l.id, debit: base.debit, credit: base.credit, ledger_account: base.ledger_account, label: l.label });
      if (l.group) groups[l.group].forEach(() => 0);
    });
  }
  // lignes lettrées liées : pour chaque ligne lettrée, les lignes du même groupe
  for (const [g, lids] of Object.entries(groups)) {
    for (const lid of lids) for (const other of lids) {
      const row = C.ledger_entry_lines.find((x) => x.id === other);
      add('ledger_entry_lines__lettered_ledger_entry_lines', { ...row }, lid);
    }
  }

  customers.forEach((c) => {
    const n = {};
    invoices.filter((i) => i.customer === c).forEach((i) => i.cat.forEach((k) => (n[k] = (n[k] ?? 0) + 1)));
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    if (top) add('customers__categories', catRef(top[0]), c.id);
  });

  // ── Comptes bancaires ──────────────────────────────────────────────────────────────────────
  add('bank_accounts', { id: bankAcct.id, name: P.bank.account, currency: 'EUR', balance: money(bankBalance), created_at: ts(START, r), updated_at: ts(NOW, r), bank_establishment: { id: bankEst }, journal: jref('BQ1'), ledger_account: aRefId(bankAcctL) });

  // ── Mandats, exports, numérotation, webhooks… ──────────────────────────────────────────────
  if (customers.length > 6) {
    const sc = customers[1];
    add('sepa_mandates', { id: ids('sepa_mandates'), bank: P.bank.name, bic: P.bank.bic, iban: sc.values.billing_iban, sequence_type: 'RCUR', signed_at: addDays(sc.created, 7), identifier: `K-${P.id}-${String(sc.id).padStart(5, '0')}`, customer: ref('customers', sc.id), created_at: ts(addDays(sc.created, 7), r), updated_at: ts(addDays(sc.created, 7), r) });
    [[customers[4], 'active'], [customers[6], 'pending_customer_approval']].forEach(([c, st]) => add('gocardless_mandates', { id: ids('gocardless_mandates'), external_reference: `MD000${code(c.name, 6)}`, customer: ref('customers', c.id), status: st, external_customer_account: `CU000${code(c.name, 6)}`, external_customer_label: c.name, created_at: ts(addDays(c.created, 10), r), updated_at: ts(addDays(c.created, 11), r) }));
    add('pro_account_mandates', { status: 'enabled', early_execution_date_permitted: false, active_billing_subscription: true, signed_at: addDays(customers[0].created, 10), created_at: ts(addDays(customers[0].created, 10), r), pdf_url: `${HOST}/rails/active_storage/blobs/redirect/${b64('mandate:1')}/mandat.pdf`, customer: ref('customers', customers[0].id) });
    add('pro_account_mandate_migrations', { id: ids('pro_account_mandate_migrations'), status: 'available', direct_debit_method: 'GoCardless', signed_at: ts(addDays(START, 90), r), error_message: null, migrated_at: null, migration_started_at: null, mandate: { id: 1, type: 'Mandate' }, customer: { id: customers[4].id, url: url(`/customers/${customers[4].id}`), pro_account_mandate: { url: url(`/pro_account/mandates?filter=${encodeURIComponent(JSON.stringify([{ field: 'customer_id', operator: 'eq', value: String(customers[4].id) }]))}`) } }, created_at: ts(addDays(START, 90), r), updated_at: ts(addDays(START, 90), r) });
  }
  ['fecs', 'general_ledgers', 'analytical_general_ledgers', ...(firm ? ['software_specific_entries'] : [])].forEach((k) => {
    const key = `exports_${k}`;
    const ext = k === 'software_specific_entries' ? 'zip' : k === 'fecs' ? 'txt' : 'xlsx';
    const id = ids(key);
    const d = FY.length > 1 ? '2026-01-20' : addDays(NOW, -20);
    add(key, { id, file_url: `${HOST}/exports/${k}/${id}/${k}_${P.id}_${FY[0].finish.slice(0, 4)}.${ext}`, status: 'ready', created_at: ts(d, r), updated_at: ts(d, r) });
  });
  [['invoice', 'F-%Y-%m-', cnt.invoice], ['credit_note', 'A-%Y-%m-', cnt.credit_note], ['estimate', 'D-%Y-%m-', cnt.estimate]].forEach(([kind, prefix, n]) => n && add('numberings', { id: ids('numberings'), kind, number_prefix: prefix, next_number: (n ?? 0) + 1 }));
  if (!firm) {
    add('webhook_subscriptions', { id: ids('webhook_subscriptions'), callback_url: 'http://localhost:5678/webhook/pennylane', events: ['customer_invoice.e_invoicing_status_updated', 'supplier_invoice.e_invoicing_received', 'dms_file.created'], enabled: true, disabled_at: null, disabled_reason: null, last_failure_status: null, last_failure_at: null, consecutive_failures: 0, created_at: ts(addDays(START, 20), r), updated_at: ts(addDays(START, 20), r) });
    add('webhook_subscriptions', { id: ids('webhook_subscriptions'), callback_url: 'https://hooks.example/pennylane-legacy', events: ['dms_file.created'], enabled: false, disabled_at: '2026-03-14T09:12:44.000Z', disabled_reason: 'repeated_failure', last_failure_status: 503, last_failure_at: '2026-03-14T09:12:44.000Z', consecutive_failures: 5, created_at: ts(addDays(START, 40), r), updated_at: '2026-03-14T09:12:44.000Z' });
    add('pa_registrations', { id: ids('pa_registrations'), siret: idn.siret, siren: idn.siren, status: 'activated', exchange_direction: 'emission_and_reception', created_at: '2026-08-24T10:53:00.000Z', updated_at: '2026-09-01T07:00:00.000Z' });
    add('purchase_requests', { id: ids('purchase_requests'), purchase_order_number: 'PR-2025-0001', supplier: ref('suppliers', suppliers.find((s) => s.range === 'capex')?.id ?? 1), delivery_address: { address: P.address, postal_code: P.postal_code, city: P.city, country_alpha2: 'FR' }, status: 'invoiced', currency: 'EUR', reason: 'Poste de travail pour nouvelle recrue graphisme', estimated_delivery_date: addDays(START, 14), amount: money(supplierInvoices.find((i) => i.s.range === 'capex')?.ttc ?? 0), currency_amount: money(supplierInvoices.find((i) => i.s.range === 'capex')?.ttc ?? 0), currency_amount_before_tax: money(supplierInvoices.find((i) => i.s.range === 'capex')?.ht ?? 0), exchange_rate: '1.0', currency_tax: money(supplierInvoices.find((i) => i.s.range === 'capex')?.tax ?? 0), tax: money(supplierInvoices.find((i) => i.s.range === 'capex')?.tax ?? 0), purchase_order: { filename: 'bon-de-commande-2025-001.pdf', url: `${HOST}/rails/active_storage/blobs/redirect/${b64('po:1')}/bon-de-commande-2025-001.pdf` }, linked_invoices: { items: [ref('supplier_invoices', supplierInvoices.find((i) => i.s.range === 'capex')?.id ?? 1)] }, created_at: ts(addDays(START, 2), r), updated_at: ts(addDays(START, 12), r) });
    add('purchase_requests', { id: ids('purchase_requests'), purchase_order_number: 'PR-2026-0002', supplier: ref('suppliers', suppliers.find((s) => s.name.startsWith('Formation'))?.id ?? 1), delivery_address: { address: P.address, postal_code: P.postal_code, city: P.city, country_alpha2: 'FR' }, status: 'to_be_validated', currency: 'EUR', reason: 'Formation accessibilité web (2 jours)', estimated_delivery_date: addDays(NOW, 30), amount: '1440.00', currency_amount: '1440.00', currency_amount_before_tax: '1200.00', exchange_rate: '1.0', currency_tax: '240.00', tax: '240.00', purchase_order: { filename: 'bon-de-commande-2026-002.pdf', url: `${HOST}/rails/active_storage/blobs/redirect/${b64('po:2')}/bon-de-commande-2026-002.pdf` }, linked_invoices: { items: [] }, created_at: ts(addDays(NOW, -5), r), updated_at: ts(addDays(NOW, -5), r) });
    }

  // Sous-ressources supplémentaires exposées par le cabinet (firm) : GED
  if (firm) {
    const folders = [['Factures clients', '/Factures clients'], ['Factures fournisseurs', '/Factures fournisseurs'], ['Juridique', '/Juridique']].map(([name, path]) => {
      const id = ids('dms_folders');
      add('dms_folders', { id, name, path, parent_folder: null, files: { url: url(`/dms/files?filter=${encodeURIComponent(JSON.stringify([{ field: 'parent_folder_id', operator: 'eq', value: String(id) }]))}`) }, created_at: ts(START, r), updated_at: ts(START, r) });
      return { id, name, path };
    });
    [['statuts-signes.pdf', 2], ['kbis.pdf', 2], ...(supplierInvoices.slice(-3).map((i) => [`${i.number}.pdf`, 1])), ...(invoices.filter((i) => !i.draft).slice(-3).map((i) => [`${i.number}.pdf`, 0]))].forEach(([name, fi]) => {
      const id = ids('dms_files'), f = folders[fi], d = addDays(NOW, -r.int(1, 120));
      add('dms_files', { id, name, path: `${f.path}/${name}`, parent_folder: { id: f.id }, url: `${HOST}/rails/active_storage/blobs/redirect/${b64('dms:' + id)}/${encodeURIComponent(name)}`, created_at: ts(d, r), updated_at: ts(d, r) });
    });
  }

  // ── Journaux de modifications (changelogs) ─────────────────────────────────────────────────
  const chg = (key, list, idOf, dateOf, updOf) => {
    const rows = [];
    list.forEach((x) => { rows.push({ id: idOf(x), operation: 'insert', at: ts(dateOf(x), r) }); const u = updOf?.(x); if (u) rows.push({ id: idOf(x), operation: 'update', at: ts(u, r) }); });
    rows.sort((a, b) => a.at.localeCompare(b.at)).forEach((x) => add(key, { id: x.id, operation: x.operation, processed_at: x.at, updated_at: x.at, created_at: x.at }));
  };
  const lastPay = (i) => i.payments?.at(-1)?.date;
  chg('changelogs_customer_invoices', invoices.filter((i) => !i.draft), (i) => i.id, (i) => i.date, lastPay);
  chg('changelogs_supplier_invoices', supplierInvoices, (i) => i.id, (i) => i.date, lastPay);
  chg('changelogs_ledger_entry_lines', entries.flatMap((e) => e.lines.map((l) => ({ id: l.id, date: e.date }))), (x) => x.id, (x) => x.date);
  if (firm) chg('changelogs_dms_files', C.dms_files ?? [], (x) => x.id, (x) => x.created_at.slice(0, 10));
  else {
    chg('changelogs_customers', customers, (c) => c.id, (c) => c.created);
    chg('changelogs_suppliers', suppliers, (s) => s.id, (s) => s.created);
    chg('changelogs_products', products, (p) => p.id, () => START);
    chg('changelogs_transactions', transactions, (t) => t.id, (t) => t.date);
    chg('changelogs_quotes', quotes, (q) => q.id, (q) => q.date);
    (C.changelogs_ledger_entry_lines_categories ??= []);
    (C.changelogs_ledger_entries_categories ??= []);
    const cl = entries.filter((e) => e.lines.some((l) => l.cats.length)).slice(0, 12);
    cl.forEach((e) => {
      const at = ts(e.date, r);
      const l = e.lines.find((x) => x.cats.length);
      add('changelogs_ledger_entry_lines_categories', { id: l.id, operation: 'insert', ledger_entry_line: { id: l.id }, ledger_entry: { id: e.id, type: e.j === 'AC' ? 'supplier_invoice' : e.j === 'VT' ? 'customer_invoice' : 'transaction' }, processed_at: at, updated_at: at, created_at: at });
      add('changelogs_ledger_entries_categories', { id: e.id, operation: 'insert', ledger_entry: { id: e.id, type: e.j === 'AC' ? 'supplier_invoice' : e.j === 'VT' ? 'customer_invoice' : 'transaction' }, processed_at: at, updated_at: at, created_at: at });
    });
  }

  // métriques internes exposées pour les contrôles de cohérence
  C.__meta = { entries: entries.length, invoices: invoices.length, supplierInvoices: supplierInvoices.length, transactions: transactions.length, bankBalance };
  return { C, idn, skipped };
}
const FIRM_NAME = 'Cabinet Delmas & Associés';
