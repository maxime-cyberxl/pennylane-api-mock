import type { AuthorizationRequest } from '../../oauth/authorization-service.js';
import type { ConsentContext, TokenContext } from '../../oauth/model.js';
import { escapeHtml as e, layout } from './html.js';

/** Valeur d'un contexte dans le formulaire : "company:101", "firm:1". */
export const encodeContext = (context: TokenContext): string => `${context.type}:${context.id}`;

export function decodeContext(value: string | undefined): TokenContext | undefined {
  const separator = value?.indexOf(':') ?? -1;
  if (value === undefined || separator < 0) return undefined;
  const type = value.slice(0, separator);
  const id = Number(value.slice(separator + 1));
  return (type === 'company' || type === 'firm') && Number.isInteger(id) && id > 0 ? { type, id } : undefined;
}

const CONTEXT_GROUPS: { type: TokenContext['type']; label: string }[] = [
  { type: 'company', label: 'Company token — une seule entreprise' },
  { type: 'firm', label: 'Firm token — le cabinet et les entreprises de son portefeuille' },
];

const contextOption = (context: ConsentContext, checked: boolean): string =>
  `<label><input type="radio" name="context" value="${e(encodeContext(context))}"${checked ? ' checked' : ''}>
    <strong>${e(context.name)}</strong> <code>${e(String(context.id))}</code>
    <span class="muted">— ${e(context.user.first_name)} ${e(context.user.last_name)} &lt;${e(context.user.email)}&gt;</span></label>`;

/** Page unique simulant les trois étapes Pennylane : connexion, choix du contexte, consentement. */
export function renderConsentPage(request: AuthorizationRequest, contexts: ConsentContext[]): string {
  const hidden = {
    client_id: request.client.id,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: request.scopes.join(' '),
    state: request.state,
  };
  const hiddenInputs = Object.entries(hidden)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${e(value)}">`)
    .join('\n');
  const contextGroups = CONTEXT_GROUPS.map(({ type, label }) => {
    const options = contexts
      .filter((context) => context.type === type)
      .map((context) => contextOption(context, context === contexts[0]))
      .join('\n');
    return options ? `<p class="group">${e(label)}</p>\n${options}` : '';
  }).join('\n');

  return layout(
    'Autoriser l’application — Pennylane (mock)',
    `<h1>Autoriser <code>${e(request.client.id)}</code></h1>
<form method="post" action="/oauth/authorize">
${hiddenInputs}
<fieldset>
  <legend>1. Connexion et contexte</legend>
  <p class="muted">Utilisateurs, entreprises et cabinets de l'api-server. Aucun mot de passe : choisir un
  contexte connecte son utilisateur.</p>
  ${contextGroups}
</fieldset>
<fieldset>
  <legend>2. Autorisation</legend>
  <dl>
    <dt>client_id</dt><dd><code>${e(request.client.id)}</code></dd>
    <dt>redirect_uri</dt><dd><code>${e(request.redirectUri)}</code></dd>
    <dt>scopes</dt><dd>${request.scopes.map((scope) => `<code>${e(scope)}</code>`).join(' ')}</dd>
    <dt>state</dt><dd>${request.state ? `<code>${e(request.state)}</code>` : '<span class="muted">(aucun)</span>'}</dd>
  </dl>
</fieldset>
<div class="actions">
  <button type="submit" name="decision" value="approve">Autoriser</button>
  <button type="submit" name="decision" value="deny" formnovalidate>Refuser</button>
</div>
</form>`,
  );
}
