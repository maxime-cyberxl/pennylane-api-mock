import { describe, expect, it } from 'vitest';
import { ApiServerDataError, loadApiServerData } from '../src/api-server/api-server-data.js';

describe("données lues dans l'api-server", () => {
  const data = loadApiServerData();

  it('propose les dossiers et le cabinet des jetons statiques de l’api-server', () => {
    expect(data.contexts.map((c) => `${c.type}:${c.id} ${c.name}`)).toEqual([
      'company:101 Atelier Lumière',
      'company:102 Boulangerie Le Fournil Doré',
      'company:103 Kiné Fontaine',
      'company:104 Holding Delmas',
      'firm:1 Cabinet Delmas & Associés',
    ]);
  });

  it('associe à chaque contexte un utilisateur de l’api-server', () => {
    expect(data.contexts.map((c) => c.user.email)).toEqual([
      'claire.lefevre@atelier-lumiere.example',
      'antoine.mercier@fournil-dore.example',
      'claire.fontaine@kine-fontaine.example',
      'etienne.delmas@holding-delmas.example',
      'helene.delmas@delmas-associes.example',
    ]);
  });

  it('accepte les scopes des specs Pennylane (API Company et Firm)', () => {
    expect(data.supportedScopes).toContain('customer_invoices:readonly');
    expect(data.supportedScopes).toContain('companies:readonly');
    expect(data.supportedScopes).not.toContain('company:read');
    expect(data.supportedScopes.length).toBeGreaterThan(40);
  });

  it('signale clairement un dossier api-server introuvable', () => {
    expect(() => loadApiServerData('/nonexistent')).toThrow(ApiServerDataError);
  });
});
