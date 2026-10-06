/** Pennylane attend des scopes séparés par des espaces (et non des virgules). */
export const parseScopeParameter = (scope: string): string[] => [
  ...new Set(scope.split(' ').filter(Boolean)),
];

/** Vérifie que tous les scopes requis ont été accordés. À utiliser pour toute API protégée. */
export const hasScopes = (granted: readonly string[], required: readonly string[]): boolean =>
  required.every((scope) => granted.includes(scope));

export const missingScopes = (granted: readonly string[], required: readonly string[]): string[] =>
  required.filter((scope) => !granted.includes(scope));
