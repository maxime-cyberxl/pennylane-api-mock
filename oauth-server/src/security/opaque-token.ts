import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Jeton opaque non devinable (256 bits, base64url), utilisé pour les codes et les tokens. */
export const generateOpaqueToken = (): string => randomBytes(32).toString('base64url');

/**
 * Empreinte SHA-256 d'un jeton : les stores n'indexent que les empreintes,
 * un dump du stockage ne permet donc pas de rejouer un token.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Comparaison en temps constant, y compris quand les longueurs diffèrent. */
export const secretsMatch = (provided: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest(),
  );
