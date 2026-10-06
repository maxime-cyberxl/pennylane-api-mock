// Jetons d'API fictifs (fixtures/tokens.json), cohérents avec les dossiers et les scopes déclarés par les specs.
//   company    : un seul dossier, implicite
//   firm       : tous les dossiers du cabinet, dossier ciblé par l'en-tête X-Company-Id sur l'API Company
//   firm-group : API firm-group (cabinets, dossiers, utilisateurs)
import { readFileSync, writeFileSync } from 'node:fs';
import { API_DEF } from './lib.mjs';
import { COMPANIES } from './profiles.mjs';

const specScopes = (api) => {
  const spec = JSON.parse(readFileSync(new URL(`../../specs/${API_DEF[api].file}`, import.meta.url)));
  const s = new Set();
  for (const it of Object.values(spec.paths)) for (const m of Object.values(it)) for (const o of m.security ?? []) Object.values(o).flat().forEach((x) => s.add(x));
  return [...s].sort();
};

export function genTokens() {
  const company = specScopes('company'), firmOnly = specScopes('firm');
  const readonly = (l) => l.filter((x) => x.endsWith(':readonly'));
  const tokens = {};
  for (const c of COMPANIES.filter((c) => c.id <= 104)) {
    tokens[`mock_company_${c.id}_full`] = { type: 'company', company: c.id, label: `Dossier ${c.name} : tous les droits`, scopes: company };
  }
  tokens.mock_company_101_readonly = { type: 'company', company: 101, label: 'Dossier Atelier Lumière : lecture seule', scopes: readonly(company) };
  tokens.mock_company_101_invoices = { type: 'company', company: 101, label: 'Dossier Atelier Lumière : factures clients et clients en lecture seule (pour tester les 403)', scopes: ['customer_invoices:readonly', 'customers:readonly'] };
  const portfolio = COMPANIES.map((c) => c.id);
  tokens.mock_firm_1_full = { type: 'firm', firm: 1, companies: portfolio, label: 'Cabinet Delmas & Associés : tous les droits, tous ses dossiers', scopes: [...company, ...firmOnly] };
  tokens.mock_firm_1_readonly = { type: 'firm', firm: 1, companies: portfolio, label: 'Cabinet Delmas & Associés : lecture seule', scopes: readonly([...company, ...firmOnly]) };
  tokens.mock_firm_group_full = { type: 'firm-group', label: 'Groupe : accès complet à l\'API firm-group', scopes: [] };
  writeFileSync(new URL('../../fixtures/tokens.json', import.meta.url), JSON.stringify(tokens, null, 2) + '\n');
  return tokens;
}
