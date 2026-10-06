import type { OAuthError } from '../../oauth/oauth-error.js';
import { escapeHtml as e, layout } from './html.js';

/** Erreur affichée à l'utilisateur quand on ne peut pas rediriger vers le client (client ou redirect_uri invalide). */
export const renderErrorPage = (error: OAuthError): string =>
  layout(
    'Erreur d’autorisation — Pennylane (mock)',
    `<h1>Autorisation impossible</h1>
<p><code>${e(error.code)}</code></p>
<p>${e(error.description)}</p>
<p class="muted">Le client OAuth est inconnu ou le redirect_uri ne correspond pas à celui enregistré :
l'utilisateur n'est pas renvoyé vers l'application.</p>`,
  );
