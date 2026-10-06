// Utilitaires communs : PRNG déterministe, dates, montants (centimes), identifiants français valides
// (SIREN/SIRET Luhn, TVA, IBAN), gabarits issus d'openapi-sampler et clés de collection json-server.
import { readFileSync } from 'node:fs';

// ── PRNG déterministe (mulberry32) : mêmes données à chaque génération ─────────────────────────
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => Math.floor(next() * (max - min + 1)) + min;
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (arr) => arr[int(0, arr.length - 1)],
    shuffle: (arr) => {
      const r = [...arr];
      for (let i = r.length - 1; i > 0; i--) {
        const j = int(0, i);
        [r[i], r[j]] = [r[j], r[i]];
      }
      return r;
    },
  };
}

// ── Dates (chaînes ISO, calculs en UTC) ────────────────────────────────────────────────────────
export const NOW = '2026-09-30';
const D = (s) => new Date(s + 'T00:00:00Z');
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => iso(new Date(D(s).getTime() + n * 86400000));
export const addMonths = (s, n) => {
  const d = D(s);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return iso(d);
};
export const endOfMonth = (s) => {
  const d = D(s);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};
export const monthStart = (s) => s.slice(0, 7) + '-01';
export const clampDay = (ym, day) => {
  const last = Number(endOfMonth(ym + '-01').slice(8));
  return `${ym}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
export const isWeekend = (s) => [0, 6].includes(D(s).getUTCDay());
export const nextWorkday = (s) => {
  while (isWeekend(s)) s = addDays(s, 1);
  return s;
};
export const months = (from, to) => {
  const out = [];
  for (let m = monthStart(from); m <= to; m = addMonths(m, 1)) out.push(m.slice(0, 7));
  return out;
};
export const ts = (date, r, hour = 9) =>
  `${date}T${String(hour + r.int(0, 8)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}:${String(r.int(0, 59)).padStart(2, '0')}.${String(r.int(0, 999999)).padStart(6, '0')}Z`;

// ── Montants : entiers en centimes, sérialisés en chaînes "123.45" comme l'API ─────────────────
export const money = (cents) => (cents / 100).toFixed(2);
export const round = (x) => Math.round(x + Number.EPSILON * Math.sign(x));
export const VAT = { FR_200: 0.2, FR_100: 0.1, FR_55: 0.055, exempt: 0 };

// ── Identifiants français valides ──────────────────────────────────────────────────────────────
export function luhnValid(s) {
  let sum = 0;
  [...s].reverse().forEach((c, i) => {
    let n = Number(c);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  });
  return sum % 10 === 0;
}
const withLuhn = (base) => {
  for (let c = 0; c < 10; c++) if (luhnValid(base + c)) return base + c;
};
export const siren = (r) => withLuhn(String(r.int(10000000, 99999999)));
export const siret = (sir, nic = 1) => withLuhn(sir + String(nic).padStart(4, '0'));
export const frVat = (sir) => `FR${String((12 + 3 * (Number(sir) % 97)) % 97).padStart(2, '0')}${sir}`;
const mod97 = (s) => [...s].reduce((acc, c) => (acc * 10 + Number(c)) % 97, 0);
export const ibanFR = (r) => {
  const bank = String(r.int(10000, 30999));
  const branch = String(r.int(1000, 9999)).padStart(5, '0');
  const acct = String(r.int(10000000000, 99999999999));
  const key = String(97 - ((89 * Number(bank) + 15 * Number(branch) + 3 * Number(acct)) % 97)).padStart(2, '0');
  const bban = bank + branch + acct + key;
  const chk = String(98 - mod97(bban + '152700')).padStart(2, '0'); // F=15 R=27
  return `FR${chk}${bban}`.replace(/(.{4})/g, '$1 ').trim().replace(/ /g, '');
};
export const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const code = (s, n) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, n).padEnd(n, 'X');
export const b64 = (s) => Buffer.from(s).toString('base64url');

// ── Identifiants séquentiels par collection ────────────────────────────────────────────────────
export const makeIds = () => {
  const c = {};
  return (k) => (c[k] = (c[k] ?? 0) + 1);
};

// ── Clé de collection json-server dérivée du chemin OpenAPI ────────────────────────────────────
// /customer_invoices/{id}/invoice_lines -> customer_invoices__invoice_lines ; /exports/fecs/{id} -> exports_fecs
export function pathInfo(path, prefix) {
  const scoped = path.match(new RegExp('^' + prefix.replace(/\//g, '\\/') + '\\/companies\\/\\{company_id\\}(\\/.*)$'));
  const rest = scoped ? scoped[1] : path.slice(prefix.length);
  const levels = [[]];
  const params = [];
  for (const seg of rest.split('/').filter(Boolean)) {
    if (/^\{.*\}$/.test(seg)) {
      params.push(seg.slice(1, -1));
      levels.push([]);
    } else levels[levels.length - 1].push(seg.replace(/-/g, '_'));
  }
  const key = levels.filter((l) => l.length).map((l) => l.join('_')).join('__');
  const detail = rest.endsWith('}');
  return { key, params, detail, nested: levels.filter((l) => l.length).length > 1, scoped: !!scoped, parentParam: detail ? params[params.length - 2] : params[params.length - 1] };
}

// ── Gabarits : échantillons openapi-sampler indexés par clé de collection ──────────────────────
export const API_DEF = {
  company: { file: 'company-v2.openapi.json', prefix: '/api/external/v2', port: 4010 },
  firm: { file: 'firm-v1.openapi.json', prefix: '/api/external/firm/v1', port: 4011 },
  'firm-group': { file: 'firm-group-v3.openapi.json', prefix: '/api/firm/v3', port: 4012 },
};

export function loadTemplates(api) {
  const raw = JSON.parse(readFileSync(new URL(`./.cache/${api}.json`, import.meta.url)));
  const out = {};
  for (const [path, v] of Object.entries(raw)) {
    const info = pathInfo(path, API_DEF[api].prefix);
    const sample = v.kind === 'list' ? v.sample : v.sample;
    // la liste est prioritaire sur le détail (mêmes champs, mais la liste peut omettre certaines clés)
    if (!out[info.key] || v.kind === 'list') out[info.key] = { sample, kind: v.kind, path, detail: out[info.key]?.detail };
    if (v.kind !== 'list' && info.detail && out[info.key]) out[info.key].detail = sample;
  }
  // clés présentes uniquement dans la vue détail : conservées dans la base, masquées par le serveur dans les listes
  for (const t of Object.values(out)) {
    if (t.detail && t.kind === 'list' && !Array.isArray(t.detail)) {
      t.extra = Object.fromEntries(Object.entries(t.detail).filter(([k]) => !(k in t.sample)));
      t.listOnly = Object.keys(t.sample).filter((k) => !(k in t.detail));
    }
  }
  return out;
}

// Ne garde que les clés présentes dans le gabarit (récursivement) : fait correspondre un objet "superset"
// à la forme exacte attendue par une API donnée (ex. ref {id,url} vs {id}).
export function fit(value, tpl) {
  if (Array.isArray(tpl)) return Array.isArray(value) ? value.map((x) => fit(x, tpl[0])) : value;
  if (tpl && typeof tpl === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const o = {};
    for (const k of Object.keys(tpl)) if (k in value) o[k] = fit(value[k], tpl[k]);
    return o;
  }
  return value;
}

// Construit un objet selon le gabarit ; trace les champs non renseignés (restés à la valeur "exemple").
export function makeRenderer(templates) {
  const untouched = {};
  const render = (key, values) => {
    const t = templates[key];
    if (!t) throw new Error(`pas de gabarit pour ${key}`);
    const out = {};
    for (const k of [...Object.keys(t.sample), ...Object.keys(t.extra ?? {})]) {
      if (k in values) { if (values[k] !== undefined) out[k] = fit(values[k], t.sample[k] ?? t.extra?.[k]); } // undefined = champ absent
      else {
        out[k] = t.sample[k] ?? t.extra?.[k];
        (untouched[key] ??= new Set()).add(k);
      }
    }
    // champs masqués (préfixe _) : clés étrangères internes pour json-server, retirées par le middleware
    for (const k of Object.keys(values)) if (k.startsWith('_')) out[k] = values[k];
    return out;
  };
  return { render, untouched };
}

// Vue liste / détail : champs à masquer selon le contexte (dérivé des specs)
export function viewMeta(api) {
  const t = loadTemplates(api);
  const meta = {};
  for (const [k, v] of Object.entries(t)) if (v.extra || v.listOnly?.length) meta[k] = { detailOnly: Object.keys(v.extra ?? {}), listOnly: v.listOnly ?? [] };
  return meta;
}
