// db-firm-group : le cabinet, ses utilisateurs, ses dossiers (mêmes identifiants que db-firm / db-company),
// webhooks et demandes de transfert. Les identifiants sont des chaînes (spécificité de l'API firm v3).
import { rng, siren as mkSiren, ts } from './lib.mjs';
import { FIRM, COMPANIES } from './profiles.mjs';
import { identity } from './company-gen.mjs';

export function generateFirmGroup({ templates, renderer }) {
  const { render } = renderer;
  const C = {};
  const add = (key, values, parent) => {
    const item = render(key, { ...values, ...(parent !== undefined ? { _parent: String(parent) } : {}) });
    (C[key] ??= []).push(item);
    return item;
  };
  const r = rng(4242);
  const FIRM2 = { id: 2, name: 'Delmas Paie & Social', reg_no: mkSiren(r), users: [
    { id: 5, first_name: 'Nadia', last_name: 'Petit', email: 'nadia.petit@delmas-paie.example', sub_role: 'accountant', role: 'accountant' },
    { id: 6, first_name: 'Olivier', last_name: 'Aubert', email: 'olivier.aubert@delmas-paie.example', sub_role: 'accountant_all_companies', role: 'accountant' },
  ] };
  const firms = [FIRM, FIRM2];
  const s = String;
  const fys = (c) => {
    if (c.not_yet_registered) return [];
    const years = c.start < '2026-01-01' ? [2025, 2026] : [2026];
    return years.map((y, i) => ({ id: c.id * 10 + i + 1, start: y === Number((c.start ?? '2025').slice(0, 4)) ? (c.start ?? `${y}-01-01`) : `${y}-01-01`, finish: `${y}-12-31`, closed_at: y < 2026 ? `${y + 1}-03-18 09:54:27 UTC` : null }));
  };

  // Dossiers du groupe : les 4 dossiers du cabinet + 2 dossiers de la filiale
  const extra = [
    { id: 105, firm: 2, name: 'Garage Moreau', legal: 'SARL', trade_name: 'Garage Moreau Automobiles', address: '52 route de Vaugirard', city: 'Angers', postal_code: '49000', fiscal_category: 'bic_is', fiscal_regime: 'fr_rn', legal_form_code: '5499', vat_frequency: 'monthly', vat_day_of_month: 19, saas_plan: 'pennylane_premium', accounting_manager_id: 6, accounting_supervisor_id: 6, accountant_id: 5, users: [{ id: 51, first_name: 'Luc', last_name: 'Moreau', email: 'luc.moreau@garage-moreau.example', sub_role: 'executive', phone: '+33241000501' }] },
    { id: 106, firm: 2, name: 'Épicerie Fine Bellevue', legal: 'SAS', trade_name: 'Bellevue Épicerie Fine', address: '9 rue des Halles', city: 'Tours', postal_code: '37000', fiscal_category: 'bic_is', fiscal_regime: 'fr_rsi', legal_form_code: '5710', vat_frequency: 'quarterly', vat_day_of_month: 24, saas_plan: 'pennylane_essentiel', accounting_manager_id: 6, accounting_supervisor_id: null, accountant_id: 5, churns_on: '2026-12-31', users: [{ id: 61, first_name: 'Inès', last_name: 'Bellevue', email: 'ines.bellevue@bellevue-epicerie.example', sub_role: 'executive', phone: '+33247000601' }] },
  ];
  const companies = [...COMPANIES.map((c) => ({ ...c, firm: 1 })), ...extra].map((c) => {
    const idn = c.id >= 105 ? { siren: mkSiren(rng(c.id)) } : identity(c);
    return { ...c, reg_no: c.not_yet_registered ? 'pending-9b1f4c6e-3a27-4d58-8f0e-51c2a7d6b340' : idn.siren };
  });

  // Utilisateurs
  const users = [];
  firms.forEach((f) => f.users.forEach((u) => users.push({ ...u, firm: f.id, company: null })));
  companies.forEach((c) => (c.users ?? []).forEach((u) => users.push({ ...u, role: 'customer', firm: null, company: c.id })));
  const pwd = (u) => (u.company ? 'password' : 'sso_saml');
  users.forEach((u) => {
    add('users', { id: s(u.id), email: u.email, first_name: u.first_name, last_name: u.last_name, blocked_at: u.blocked_at ?? null, role: u.role, authentication_method: pwd(u), phone_number: u.phone ?? null, sub_role: u.sub_role });
  });
  firms.forEach((f) => {
    add('firms', { id: s(f.id), name: f.name, reg_no: f.reg_no });
    f.users.forEach((u) => add('firms__users', { id: s(u.id), first_name: u.first_name, last_name: u.last_name, email: u.email, blocked_at: u.blocked_at ?? null }, f.id));
  });
  companies.forEach((c) => {
    const firmUsers = firms.find((f) => f.id === c.firm).users;
    const v = {
      id: s(c.id), firm_id: s(c.firm), reg_no: c.reg_no, name: `${c.name} ${c.legal}`.replace(/^(Kiné Fontaine) SELARL$/, 'Kiné Fontaine SELARL'), trade_name: c.trade_name, address: c.address, city: c.city, postal_code: c.postal_code, country_alpha2: 'FR',
      saas_plan: c.saas_plan, not_yet_registered: !!c.not_yet_registered, accounting_manager_id: c.accounting_manager_id ? s(c.accounting_manager_id) : null, accounting_supervisor_id: c.accounting_supervisor_id ? s(c.accounting_supervisor_id) : null,
      accountant_id: c.accountant_id ? s(c.accountant_id) : null,
      supplier_invoice_transmission_emails: [`${c.client_code?.toLowerCase().replace('dossier_', '') ?? c.id}@suppliers.pennylane.example`],
      customer_invoice_transmission_emails: [`${c.client_code?.toLowerCase().replace('dossier_', '') ?? c.id}@customers.pennylane.example`],
      fiscal_category: c.fiscal_category, fiscal_regime: c.fiscal_regime, legal_form_code: c.legal_form_code, vat_frequency: c.vat_frequency, vat_day_of_month: c.vat_day_of_month,
      tos_accepted_at: c.not_yet_registered ? null : `${c.start ?? '2025-01-01'}T09:14:22.480213Z`, churns_on: c.churns_on ?? null, file_type: 'revision', fiscal_years: fys(c),
    };
    add('companies', v);
    add('firms__companies', v, c.firm);
    // utilisateurs rattachés : les utilisateurs du dossier + les comptables du cabinet affectés
    const assigned = [...(c.users ?? []).map((u) => ({ ...u, role: u.sub_role })), ...firmUsers.filter((u) => [c.accounting_manager_id, c.accountant_id].includes(u.id)).map((u) => ({ ...u, role: u.sub_role }))];
    assigned.forEach((u) => add('companies__users', { id: s(u.id), first_name: u.first_name, last_name: u.last_name, email: u.email, role: u.role, blocked_at: u.blocked_at ?? null }, c.id));
  });

  add('webhook_subscriptions', { id: 1, url: 'http://localhost:5678/webhook/pennylane-firm', events: ['company_created', 'company_updated', 'user_created', 'user_updated'], active: true, secret: 'whsec_4f9c1d7e2b8a4c6fa3d05e91b7c2d8f1' });
  add('webhook_subscriptions', { id: 2, url: 'https://hooks.example/transfers', events: ['transfer_request_created', 'transfer_request_updated'], active: false, secret: 'whsec_b81e3a5c9d2f47e0a6c14d3b5f7e9a20' });

  add('transfer_requests_list_inbound', { id: 'tr_7f3a91', status: 'pending', error: null, answered_at: null, transfered_at: null, transfer_type: 'full', sender_firm_name: 'Cabinet Aubry Conseil', recipient_firm_name: FIRM.name, source_company_id: '88412', company_name: 'SCI Les Tilleuls' });
  add('transfer_requests_list_inbound', { id: 'tr_2c8e04', status: 'finished', error: null, answered_at: '2026-05-06T09:41:12.000Z', transfered_at: '2026-05-07T02:10:45.000Z', transfer_type: 'full', sender_firm_name: 'Expertise Loire Audit', recipient_firm_name: FIRM.name, source_company_id: '77120', company_name: 'Kiné Fontaine SELARL' });
  add('transfer_requests_list_outbound', { id: 'tr_9d1b57', status: 'accepted', error: null, answered_at: '2026-09-12T14:03:30.000Z', transfered_at: null, transfer_type: 'full', sender_firm_name: FIRM2.name, destination_company_id: '106', company_name: 'Épicerie Fine Bellevue SAS' });
  add('transfer_requests_list_outbound', { id: 'tr_5a6e32', status: 'failed', error: 'destination_firm_not_found', answered_at: null, transfered_at: null, transfer_type: 'full', sender_firm_name: FIRM.name, destination_company_id: '104', company_name: 'Holding Delmas SAS' });

  C.me = { first_name: 'Hélène', last_name: 'Delmas', email: 'helene.delmas@delmas-associes.example', permitted_authentication_methods: ['password', 'sso_saml'] };
  return { C };
}
