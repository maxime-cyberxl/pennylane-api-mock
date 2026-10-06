// Génère, à partir des specs OpenAPI et des clés présentes dans db-<api>.json :
//   routes-<api>.json : réécriture /api/external/... -> collections json-server (plates, clés parent/dossier en `_parent` / `_company`)
//   meta-<api>.json   : enveloppe de liste, tri par défaut, limite max, champs propres à la vue liste / détail
import { readFileSync, writeFileSync } from 'node:fs';
import { pathInfo, API_DEF, viewMeta } from '../generator/lib.mjs';

const ALIAS = { company_customers: 'customers', individual_customers: 'customers' };
const here = (f) => new URL(f, import.meta.url);

export function genRoutes(api) {
  const spec = JSON.parse(readFileSync(here(`../../specs/${API_DEF[api].file}`)));
  const raw = JSON.parse(readFileSync(here(`../generator/.cache/${api}.json`)));
  const db = JSON.parse(readFileSync(here(`../../fixtures/db-${api}.json`)));
  const { prefix } = API_DEF[api];
  const routes = {};
  const meta = {};
  const views = viewMeta(api);
  // scopes requis par opération (au moins un des scopes listés dans la spec)
  const scopes = [];
  for (const [path, item] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(item)) {
    const need = [...new Set((op.security ?? []).flatMap((o) => Object.values(o).flat()))];
    if (need.length) scopes.push({ method: method.toUpperCase(), re: '^' + path.replace(/\{\w+\}/g, '[^/]+') + '/?$', scopes: need });
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    const info = pathInfo(path, prefix);
    const key = ALIAS[info.key] ?? info.key;
    if (!(key in db)) continue;
    const from = path.replace(/\{(\w+)\}/g, ':$1');
    const singular = !Array.isArray(db[key]);
    let to;
    if (singular) to = `/${key}`;
    else if (info.detail) to = `/${key}/:id`;
    else if (info.nested) to = `/${key}?_parent=:${info.parentParam}`;
    else to = `/${key}${info.scoped ? '?_company=:company_id' : ''}`;
    const aliasQ = ALIAS[info.key] && info.detail ? `?_alias=${info.key}` : '';
    if (from !== to + aliasQ) routes[from] = to + aliasQ;
    if (item.get && !info.detail) {
      const r = raw[path];
      const p = (n) => item.get.parameters?.find((x) => x.name === n);
      meta[key] = { arrayKey: r?.arrayKey ?? null, paging: r?.paging ?? [], sort: p('sort')?.schema?.default ?? null, limitMax: p('limit')?.schema?.maximum ?? 100, ...views[key] };
    }
  }
  for (const [k, v] of Object.entries(views)) meta[k] = { ...(meta[k] ?? {}), ...v };
  // alias company_customers / individual_customers : même collection, vue détail propre à chaque type
  const custKeys = Object.keys(raw[`${prefix}/customers`]?.sample ?? {});
  meta.__aliases = Object.fromEntries(Object.entries({ company_customers: 'company', individual_customers: 'individual' }).filter(([k]) => raw[`${prefix}/${k}/{id}`]).map(([k, type]) => [k, { name: k, type, hide: custKeys.filter((x) => !(x in raw[`${prefix}/${k}/{id}`].sample)) }]));
  // alias : les vues détail de company_customers / individual_customers sont celles de customers
  writeFileSync(here(`./generated/routes-${api}.json`), JSON.stringify(routes, null, 2) + '\n');
  writeFileSync(here(`./generated/meta-${api}.json`), JSON.stringify(meta, null, 2) + '\n');
  writeFileSync(here(`./generated/scopes-${api}.json`), JSON.stringify(scopes, null, 1) + '\n');
  return { routes: Object.keys(routes).length, collections: Object.keys(meta).length };
}

if (process.argv[1].endsWith('gen-routes.mjs')) for (const api of Object.keys(API_DEF)) console.log(api, genRoutes(api));
