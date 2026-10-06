// Couche "API Pennylane" au-dessus de json-server : enveloppes de liste, filter/sort/limit/cursor (ou page/per_page),
// masquage des clés internes (_parent, _company), vues liste/détail, balance calculée depuis les écritures,
// PUT partiel, horodatages, hôte des URL réécrit vers le serveur courant, PDF de démonstration, FEC généré.
import { readFileSync, existsSync } from 'node:fs';

const HOST = 'https://app.pennylane.com';
const PDF_DIR = new URL('../../fixtures/invoices/', import.meta.url);
const BAD = (res, msg, status = 400) => res.status(status).json({ status, error: msg });

const strip = (o) => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, strip(v)]));
  return o;
};
const omit = (o, keys) => (keys?.length ? Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) : o);

// ── filtre JSON Pennylane : [{"field":"date","operator":"gteq","value":"2025-01-01"}] ──────────
const asList = (v) => {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v);
  try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String); } catch { /* liste "a,b" */ }
  return s.split(',').map((x) => x.trim());
};
const resolve = (item, field, ctx) => {
  if (field === 'category_id') {
    if (Array.isArray(item.categories)) return { found: true, value: item.categories.map((c) => c.id) };
    const sub = ctx.state[`${ctx.key}__categories`] ?? [];
    return { found: true, value: sub.filter((c) => String(c._parent) === String(item.id)).map((c) => c.id) };
  }
  if (field in item) return { found: true, value: item[field] };
  if (field === 'flow_id') return { found: true, value: item.e_invoicing?.flow?.id ?? null };
  if (field.endsWith('_id') && item[field.slice(0, -3)] !== undefined) return { found: true, value: item[field.slice(0, -3)]?.id ?? null };
  return { found: false };
};
const cmp = (a, b) => (typeof a === 'number' ? Number(b) - a : String(b) === String(a) ? 0 : String(a) < String(b) ? -1 : 1) * (typeof a === 'number' ? -1 : 1);
const matches = (item, { field, operator, value }, ctx) => {
  const { found, value: v } = resolve(item, field, ctx);
  if (!found) return true; // champ inconnu : on n'exclut pas (l'API réelle répondrait 400)
  if (Array.isArray(v)) return operator === 'in' ? asList(value).some((x) => v.map(String).includes(x)) : v.map(String).includes(String(value));
  const norm = (x) => (typeof v === 'number' ? Number(x) : typeof v === 'boolean' ? String(x) === 'true' : String(x));
  const c = (x) => (v < norm(x) ? -1 : v > norm(x) ? 1 : 0);
  switch (operator) {
    case 'eq': return v === norm(value);
    case 'not_eq': return v !== norm(value);
    case 'lt': return v !== null && c(value) < 0;
    case 'lteq': return v !== null && c(value) <= 0;
    case 'gt': return v !== null && c(value) > 0;
    case 'gteq': return v !== null && c(value) >= 0;
    case 'in': return asList(value).map((x) => String(norm(x))).includes(String(v));
    case 'not_in': return !asList(value).map((x) => String(norm(x))).includes(String(v));
    case 'start_with': return typeof v === 'string' && v.toLowerCase().startsWith(String(value).toLowerCase());
    default: return true;
  }
};

const cents = (s) => Math.round(Number(s) * 100);
const fmt = (c) => (c / 100).toFixed(2);

// Réécriture /api/external/... -> collections (json-server.rewriter ne gère pas les URL portant une query string)
export function rewriter(routes) {
  const rules = Object.entries(routes).map(([from, to]) => {
    const names = [];
    const re = new RegExp('^' + from.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
    return { re, names, to };
  });
  return (req, res, next) => {
    const [path, search = ''] = req.url.split('?');
    for (const { re, names, to } of rules) {
      const m = path.match(re);
      if (!m) continue;
      const vars = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const [tp, tq = ''] = to.replace(/:(\w+)/g, (_, n) => encodeURIComponent(vars[n])).split('?');
      const q = [tq, search].filter(Boolean).join('&');
      req.url = tp + (q ? `?${q}` : '');
      const query = {};
      for (const [k, v] of new URLSearchParams(q)) query[k] = k in query ? [].concat(query[k], v) : v;
      req.query = query;
      break;
    }
    next();
  };
}

// ── Authentification : jeton Company / Firm / Firm group, cloisonnement par dossier, scopes ──────────
// Company API  : jeton company (dossier implicite) ou jeton firm + en-tête X-Company-Id
// Firm API     : jeton firm, dossier dans l'URL (/companies/:company_id/...)
// Firm group   : jeton firm-group
// Jetons acceptés : les jetons statiques de fixtures/tokens.json, et les access tokens émis par le mock OAuth
// (oauth-server), vérifiés à chaque requête auprès de son endpoint d'introspection.
export function auth({ api, tokens, scopes, enabled = true, defaultCompany = 101, introspectionUrl }) {
  const rules = scopes.map((s) => ({ ...s, re: new RegExp(s.re) }));
  const accepts = { company: ['company', 'firm'], firm: ['firm'], 'firm-group': ['firm-group'] }[api];
  const open = /^\/(public\/|rails\/)|\/exports\/\w+\/\d+\/[^/]+$/;
  const deny = (res, status, error) => res.status(status).json({ status, error });
  const introspect = oauthIntrospection(introspectionUrl, tokens);
  // Express 4 (json-server) ne capture pas les erreurs des middlewares async : on les transmet à next.
  return (req, res, next) => check(req, res, next).catch(next);
  async function check(req, res, next) {
    if (open.test(req.path)) return next();
    const urlCompany = api === 'firm' ? Number(req.path.match(/\/companies\/(\d+)/)?.[1]) || undefined : undefined;
    if (!enabled) {
      req.ctx = { company: urlCompany ?? (api === 'company' ? Number(req.get('X-Company-Id')) || defaultCompany : undefined) };
      return next();
    }
    const raw = req.get('Authorization') ?? '';
    const bearer = raw.replace(/^Bearer\s+/i, '');
    let token = tokens[bearer];
    if (!token && bearer) {
      const oauth = await introspect(bearer);
      if (oauth.error) return deny(res, 401, oauth.error);
      token = oauth.token;
    }
    if (!raw || !token) return deny(res, 401, 'The access token is invalid');
    if (!accepts.includes(token.type)) return deny(res, 403, `A ${token.type} token cannot be used on the ${api} API`);
    let company, companies;
    if (api === 'company') {
      if (token.type === 'company') company = token.company;
      else {
        const h = req.get('X-Company-Id');
        if (!h) return deny(res, 400, 'The X-Company-Id header is required when using a firm token');
        company = Number(h);
        if (!token.companies.includes(company)) return deny(res, 403, `Company ${h} does not belong to your firm`);
      }
    } else if (api === 'firm') {
      companies = token.companies;
      if (urlCompany !== undefined) { if (!companies.includes(urlCompany)) return deny(res, 403, `Company ${urlCompany} does not belong to your firm`); company = urlCompany; }
    }
    const rule = rules.find((r) => r.method === req.method && r.re.test(req.path));
    if (rule && !rule.scopes.some((s) => token.scopes.includes(s))) return deny(res, 403, `Missing scope: one of ${rule.scopes.join(', ')}`);
    req.ctx = { company, companies, token };
    next();
  }
}

// ── Access tokens OAuth : introspection auprès de l'oauth-server ─────────────────────────────────────
// Le token est traduit en jeton du mock : company → son dossier ; firm → le portefeuille du cabinet dans tokens.json.
const INACTIVE = { expired: 'The access token expired', revoked: 'The access token was revoked' };
function oauthIntrospection(url, tokens) {
  return async (accessToken) => {
    if (!url) return { error: 'The access token is invalid' };
    let result;
    try {
      const response = await fetch(url, { method: 'POST', body: new URLSearchParams({ token: accessToken }), signal: AbortSignal.timeout(2000) });
      result = await response.json();
    } catch {
      return { error: 'The access token is invalid (OAuth mock unreachable)' };
    }
    if (!result.active) return { error: INACTIVE[result.reason] ?? 'The access token is invalid' };
    const scopes = result.scope.split(' ').filter(Boolean);
    const { type, id } = result.context;
    if (type === 'company') return { token: { type, company: id, scopes } };
    const firm = Object.values(tokens).find((t) => t.type === 'firm' && t.firm === id);
    return { token: { type, firm: id, companies: firm?.companies ?? [], scopes } };
  };
}

export function plMiddleware({ api, db, meta, origin: fixedOrigin }) {
  const firm = api === 'firm';
  const state = () => db.getState();

  // ── balance générale calculée depuis les écritures (cohérente avec la base, y compris après POST) ──
  function trialBalance(req, res) {
    const q = req.query;
    const company = req.ctx?.company;
    const st = state();
    const inCompany = (x) => company === undefined || x._company === company;
    const fys = (st.fiscal_years ?? []).filter(inCompany).sort((a, b) => a.start.localeCompare(b.start));
    const fy = fys.at(-1);
    const start = q.period_start ?? fy?.start, end = q.period_end ?? fy?.finish;
    if (!start || !end) return BAD(res, 'period_start and period_end are required');
    const aux = String(q.is_auxiliary) === 'true';
    const accounts = Object.fromEntries((st.ledger_accounts ?? []).filter(inCompany).map((a) => [a.id, a]));
    const byNumber = Object.fromEntries(Object.values(accounts).map((a) => [a.number, a]));
    const rows = {};
    for (const l of (st.ledger_entry_lines ?? []).filter(inCompany)) {
      if (l.date < start || l.date > end) continue;
      const a = accounts[l.ledger_account.id];
      const isAux = /^(401|411)./.test(a.number);
      const num = !aux && isAux ? a.number.slice(0, 3) : a.number;
      const label = !aux && isAux ? byNumber[num]?.label ?? a.label : a.label;
      const r = (rows[num] ??= { number: num, formatted_number: num.padEnd(8, '0'), label, d: 0, c: 0 });
      r.d += cents(l.debit); r.c += cents(l.credit);
    }
    const all = Object.values(rows).sort((a, b) => a.number.localeCompare(b.number)).map((r) => ({ number: r.number, formatted_number: r.formatted_number, label: r.label, debits: fmt(r.d), credits: fmt(r.c) }));
    return paginate(req, res, all, { arrayKey: 'items', paging: firm ? ['total_pages', 'current_page', 'total_items', 'per_page'] : ['has_more', 'next_cursor'], limitMax: 1000 });
  }

  // ── pagination / enveloppe ───────────────────────────────────────────────────────────────
  function paginate(req, res, rows, m) {
    const pl = req.pl ?? {};
    const style = m.paging?.includes('has_more') ? 'cursor' : m.paging?.includes('total_pages') ? 'page' : m.paging?.includes('pagination') ? 'pagination' : 'plain';
    const key = m.arrayKey ?? 'items';
    if (style === 'plain') return res.json({ [key]: rows });
    if (style === 'cursor') {
      const limit = pl.limit === undefined ? 20 : Number(pl.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > (m.limitMax ?? 100)) return BAD(res, `limit must be between 1 and ${m.limitMax ?? 100}`);
      let offset = 0;
      if (pl.cursor) { try { offset = JSON.parse(Buffer.from(String(pl.cursor), 'base64url').toString()).o; } catch { offset = -1; } if (!Number.isInteger(offset) || offset < 0) return BAD(res, 'invalid cursor'); }
      const slice = rows.slice(offset, offset + limit);
      const more = offset + limit < rows.length;
      return res.json({ [key]: slice, has_more: more, next_cursor: more ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : null });
    }
    const per = Number(pl.per_page ?? 20) || 20, page = Math.max(1, Number(pl.page ?? 1) || 1);
    const slice = rows.slice((page - 1) * per, page * per);
    const pages = Math.max(1, Math.ceil(rows.length / per));
    if (style === 'page') return res.json({ [key]: slice, total_pages: pages, current_page: page, ...(m.paging.includes('total_items') ? { total_items: rows.length, per_page: per } : {}) });
    return res.json({ [key]: slice, pagination: { page, pages, pageSize: per, totalEntries: rows.length, totalEntriesStr: String(rows.length), totalEntriesPrecision: 'exact' } });
  }

  // ── FEC réel généré depuis les écritures ─────────────────────────────────────────────────
  function fec(req, res) {
    const st = state();
    const exp = (st.exports_fecs ?? []).find((e) => String(e.id) === req.path.match(/fecs\/(\d+)/)?.[1]);
    if (!exp) return BAD(res, 'export not found', 404);
    const inCompany = (x) => x._company === exp._company;
    const y = exp.file_url.match(/_(\d{4})\./)?.[1];
    const accounts = Object.fromEntries(st.ledger_accounts.filter(inCompany).map((a) => [a.id, a]));
    const journals = Object.fromEntries(st.journals.filter(inCompany).map((j) => [j.id, j]));
    const entries = Object.fromEntries(st.ledger_entries.filter(inCompany).map((e) => [e.id, e]));
    const fr = (c) => String(c).replace('.', ',');
    const head = 'JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise';
    const rows = st.ledger_entry_lines.filter(inCompany).filter((l) => l.date.startsWith(y)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).map((l) => {
      const a = accounts[l.ledger_account.id], e = entries[l.ledger_entry.id], j = journals[l.journal.id];
      const aux = /^(401|411)./.test(a.number);
      const d = l.date.replaceAll('-', '');
      const let_ = l.lettered_ledger_entry_lines.ids.length ? `L${Math.min(...l.lettered_ledger_entry_lines.ids)}` : '';
      return [j.code, j.label, e.id, d, aux ? a.number.slice(0, 3).padEnd(6, '0') : a.number.padEnd(6, '0'), aux ? (accounts[Object.values(accounts).find((g) => g.number === a.number.slice(0, 3))?.id]?.label ?? a.label) : a.label, aux ? a.number : '', aux ? a.label : '', e.piece_number ?? '', d, l.label, fr(l.debit), fr(l.credit), let_, let_ ? d : '', d, '', ''].join('\t');
    });
    res.type('text/plain; charset=utf-8').send([head, ...rows].join('\n') + '\n');
  }

  // ── PDF de démonstration (factures, pièces jointes) ──────────────────────────────────────
  function pdf(req, res) {
    const token = req.query.encrypted_id ?? req.path.split('/')[5] ?? '';
    const what = Buffer.from(String(token), 'base64url').toString();
    const f = new URL(what.startsWith('supplier_invoice') ? 'supplier.demo.pdf' : 'customer.demo.pdf', PDF_DIR);
    if (!existsSync(f)) return BAD(res, 'demo pdf not found', 404);
    res.type('application/pdf').send(readFileSync(f));
  }

  const pre = (req, res, next) => {
    const origin = fixedOrigin ?? `${req.protocol}://${req.get('host')}`;
    if (req.method === 'GET' && (req.path === '/public/invoice/pdf' || req.path.startsWith('/rails/active_storage/blobs/redirect/'))) return pdf(req, res);
    if (req.method === 'GET' && /\/exports\/fecs\/\d+\/[^/]+$/.test(req.path)) return fec(req, res);

    // paramètres propres à Pennylane : retirés avant json-server (qui les interpréterait comme des filtres)
    const pl = {};
    for (const k of ['filter', 'sort', 'limit', 'cursor', 'page', 'per_page', 'include', 'start_date', 'period_start', 'period_end', 'is_auxiliary']) {
      if (k in req.query) { pl[k] = req.query[k]; if (!['period_start', 'period_end', 'is_auxiliary'].includes(k)) delete req.query[k]; }
    }
    req.pl = pl;
    if (req.method === 'GET' && /\/trial_balance$/.test(req.path)) return trialBalance(req, res);

    const key0 = req.path.split('/')[1];
    const ctx = req.ctx ?? {};
    // /me et /company/features : l'objet du dossier ciblé (les scopes de /me sont ceux du jeton)
    if (api === 'company' && req.method === 'GET' && ['me', 'company_features'].includes(key0)) {
      const row = (state()[key0] ?? []).find((x) => x._company === ctx.company);
      if (!row) return BAD(res, 'company not found', 404);
      const out = strip(row);
      if (key0 === 'me' && ctx.token) out.scopes = ctx.token.scopes;
      return res.json(JSON.parse(JSON.stringify(out).split(HOST).join(origin)));
    }
    // cloisonnement : un dossier (jeton company, X-Company-Id ou URL firm) ; le cabinet voit son portefeuille
    if (req.method === 'GET' && ctx.company !== undefined) req.query._company = String(ctx.company);
    if (api === 'firm' && key0 === 'companies' && ctx.companies) req.portfolio = ctx.companies;

    // l'API Pennylane met à jour partiellement avec PUT ; json-server remplacerait l'objet entier
    if (req.method === 'PUT') req.method = 'PATCH';
    if (['POST', 'PATCH'].includes(req.method) && req.body && typeof req.body === 'object') {
      const now = new Date().toISOString().replace('Z', '000Z');
      if (req.method === 'POST') { req.body.created_at ??= now; if (ctx.company !== undefined) req.body._company = ctx.company; }
      req.body.updated_at = now;
    }

    const key = req.path.split('/')[1];
    const m = meta[key] ?? {};
    const detail = req.path.split('/').length > 2;
    const alias = meta.__aliases?.[req.query._alias];
    delete req.query._alias;
    const orig = res.jsonp.bind(res);
    res.jsonp = (data) => {
      if (req.method === 'GET' && Array.isArray(data)) {
        let rows = data.map((x) => omit(x, m.detailOnly));
        if (req.portfolio) rows = rows.filter((x) => req.portfolio.includes(x.id));
        if (pl.filter) {
          let f;
          try { f = JSON.parse(pl.filter); if (!Array.isArray(f)) throw new Error(); } catch { return res.status(400).json({ status: 400, error: 'filter must be a JSON array of {field, operator, value}' }); }
          rows = rows.filter((x) => f.every((c) => matches(x, c, { state: state(), key })));
        }
        if (pl.start_date) rows = rows.filter((x) => (x.processed_at ?? '') >= pl.start_date);
        const sort = pl.sort ?? m.sort;
        if (sort) {
          const keys = String(sort).split(',').map((s) => [s.replace(/^-/, ''), s.startsWith('-') ? -1 : 1]);
          rows = [...rows].sort((a, b) => { for (const [k, dir] of keys) { const x = a[k], y = b[k]; if (x === y) continue; return (x > y ? 1 : -1) * dir; } return 0; });
        }
        const out = capture(rows, m);
        if (out === null) return res; // réponse d'erreur déjà envoyée
        return send(out);
      }
      if (req.method === 'GET' && detail && data && typeof data === 'object' && data._company !== undefined && ctx.company !== undefined && data._company !== ctx.company) return res.status(404).json({ status: 404, error: 'Not found' });
      if (req.method === 'GET' && detail && data && typeof data === 'object') {
        data = omit(data, m.listOnly);
        if (alias && data.id !== undefined) { if (data.customer_type !== alias.type) return res.status(404).json({ status: 404, error: `${alias.name} not found` }); data = omit(data, alias.hide); }
      }
      return send(data);
    };
    const jsonp0 = res.jsonp;
    res.jsonp = (d) => { try { return jsonp0(d); } catch (e) { return res.status(500).json({ status: 500, error: String(e.message) }); } };
    // réponses de liste : paginate() appelle res.json -> on intercepte pour réécrire l'hôte et purger les clés internes
    const capture = (rows, mm) => {
      let body;
      const fake = { ...res, json: (b) => { body = b; return res; }, status: (s) => { res.status(s); return { json: (b) => { res.json(b); body = null; return res; } }; } };
      paginate(req, fake, rows, mm);
      if (body === undefined) return null;
      return body;
    };
    const send = (data) => { if (data === null) return res; return orig(JSON.parse(JSON.stringify(strip(data)).split(HOST).join(origin))); };
    next();
  };
  return pre;
}
