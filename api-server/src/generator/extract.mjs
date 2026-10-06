// Étape 1 : échantillonne chaque endpoint GET "liste" / "détail" des specs avec openapi-sampler
// (utilise les `example` des specs) et écrit src/generator/.cache/<api>.json -> { resource: {listPath, itemSchema, sample} }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { sample } from 'openapi-sampler';

export const APIS = {
  company: 'company-v2.openapi.json',
  firm: 'firm-v1.openapi.json',
  'firm-group': 'firm-group-v3.openapi.json',
};

const json = (r) => r?.content?.['application/json']?.schema;

const flat = (schema) =>
  schema.allOf
    ? schema.allOf.map(flat).reduce((a, x) => ({ ...a, ...x, properties: { ...a.properties, ...x.properties } }), {})
    : schema;

// Une réponse "liste" est soit { items, has_more, next_cursor } (company / firm), soit une enveloppe paginée par page
// { total_pages, current_page, <collection>: [...] } (firm-group), soit { <x>_transfer_requests: {...}, pagination }.
export function listResources(spec) {
  const out = {};
  for (const [path, item] of Object.entries(spec.paths)) {
    const get = item.get;
    const schema = json(get?.responses?.['200']);
    if (!schema) continue;
    const s = sample(schema, { skipReadOnly: false, quiet: true }, spec);
    const props = flat(schema).properties ?? {};
    const detailPath = path.endsWith('}');
    let arrayKey = Object.keys(props).find((k) => k === 'items' || (props[k].type === 'array' && props[k].items?.type === 'object'));
    if (!arrayKey && !detailPath) arrayKey = Object.keys(props).find((k) => /_transfer_requests$/.test(k));
    if (arrayKey && !detailPath) {
      const p = props[arrayKey];
      const itemSchema = p.type === 'array' ? p.items : p;
      const first = Array.isArray(s[arrayKey]) ? s[arrayKey][0] : s[arrayKey];
      out[path] = { kind: 'list', arrayKey, itemSchema, responseSchema: schema, sample: first ?? null, paging: Object.keys(s).filter((k) => k !== arrayKey), params: (get.parameters ?? []).map((x) => ({ name: x.name, in: x.in, default: x.schema?.default })) };
    } else {
      out[path] = { kind: 'single', schema, sample: s, params: (get.parameters ?? []).map((x) => ({ name: x.name, in: x.in, default: x.schema?.default })) };
    }
  }
  return out;
}

if (process.argv[1].endsWith('extract.mjs')) {
  mkdirSync(new URL('./.cache/', import.meta.url), { recursive: true });
  for (const [api, file] of Object.entries(APIS)) {
    const spec = JSON.parse(readFileSync(new URL('../../specs/' + file, import.meta.url)));
    const res = listResources(spec);
    writeFileSync(new URL(`./.cache/${api}.json`, import.meta.url), JSON.stringify(res, null, 2));
    console.log(api, Object.keys(res).length, 'endpoints GET échantillonnés');
  }
}
