import { OAuthError } from '../oauth/oauth-error.js';

/**
 * Extrait des paramètres OAuth d'une query string ou d'un corps form-urlencoded.
 * Un paramètre répété est refusé (RFC 6749 §3.1 : « MUST NOT be included more than once »).
 */
export function readParams<Name extends string>(
  source: unknown,
  names: readonly Name[],
): Record<Name, string | undefined> {
  const values = (typeof source === 'object' && source !== null ? source : {}) as Record<string, unknown>;
  const params = {} as Record<Name, string | undefined>;
  for (const name of names) {
    const value = values[name];
    if (value !== undefined && typeof value !== 'string') throw new OAuthError('invalid_request');
    params[name] = value;
  }
  return params;
}
