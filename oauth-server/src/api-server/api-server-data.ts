// Lit les fichiers de l'api-server voisin, pour que le mock OAuth parle des mêmes choses que l'API :
//   - les contextes proposés au consentement (entreprises, cabinet, utilisateurs) : fixtures/ ;
//   - les scopes acceptés : ceux des specs Pennylane, extraits dans src/server/generated/scopes-*.json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConsentContext, ResourceOwner } from '../oauth/model.js';

export const DEFAULT_API_SERVER_DIR = fileURLToPath(new URL('../../../api-server/', import.meta.url));

export interface ApiServerData {
  /** Contextes des jetons statiques de l'api-server (fixtures/tokens.json), avec leur utilisateur. */
  contexts: ConsentContext[];
  /** Tous les scopes des API Company et Firm, triés. */
  supportedScopes: string[];
}

export class ApiServerDataError extends Error {}

// ── Forme (partielle) des fichiers de l'api-server ─────────────────────────────────────
type FixtureToken =
  | { type: 'company'; company: number }
  | { type: 'firm'; firm: number; companies: number[] }
  | { type: 'firm-group' };

interface CompanyDatabase {
  me: { _company: number; company: { id: number; name: string }; user: ResourceOwner }[];
}

interface FirmGroupDatabase {
  firms: { id: string; name: string }[];
  firms__users: { id: string; first_name: string; last_name: string; email: string; _parent: string }[];
}

type ScopeRules = { scopes: string[] }[];

const readJson = (dir: string, file: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiServerDataError(`fichier de l'api-server illisible (${join(dir, file)}) : ${reason}`);
  }
};

export function loadApiServerData(dir: string = DEFAULT_API_SERVER_DIR): ApiServerData {
  const tokens = Object.values(readJson(dir, 'fixtures/tokens.json') as Record<string, FixtureToken>);
  const companyDb = readJson(dir, 'fixtures/db-company.json') as CompanyDatabase;
  const firmGroupDb = readJson(dir, 'fixtures/db-firm-group.json') as FirmGroupDatabase;
  const scopeRules = ['company', 'firm'].flatMap(
    (api) => readJson(dir, `src/server/generated/scopes-${api}.json`) as ScopeRules,
  );

  const companyIds = new Set<number>();
  const firmIds = new Set<number>();
  for (const token of tokens) {
    if (token.type === 'company') companyIds.add(token.company);
    if (token.type === 'firm') firmIds.add(token.firm);
  }

  const companyContexts: ConsentContext[] = [...companyIds]
    .sort((a, b) => a - b)
    .map((id) => {
      const entry = companyDb.me.find((me) => me._company === id);
      if (!entry)
        throw new ApiServerDataError(`aucun utilisateur /me pour l'entreprise ${id} dans db-company.json`);
      const { id: userId, first_name, last_name, email } = entry.user;
      return {
        type: 'company',
        id,
        name: entry.company.name,
        user: { id: userId, first_name, last_name, email },
      };
    });

  const firmContexts: ConsentContext[] = [...firmIds]
    .sort((a, b) => a - b)
    .map((id) => {
      const firm = firmGroupDb.firms.find((f) => Number(f.id) === id);
      // Premier collaborateur du cabinet : dans les fixtures, l'expert-comptable associé.
      const user = firmGroupDb.firms__users.find((u) => Number(u._parent) === id);
      if (!firm || !user)
        throw new ApiServerDataError(`cabinet ${id} ou ses utilisateurs absents de db-firm-group.json`);
      const { first_name, last_name, email } = user;
      return {
        type: 'firm',
        id,
        name: firm.name,
        user: { id: Number(user.id), first_name, last_name, email },
      };
    });

  return {
    contexts: [...companyContexts, ...firmContexts],
    supportedScopes: [...new Set(scopeRules.flatMap((rule) => rule.scopes))].sort(),
  };
}
