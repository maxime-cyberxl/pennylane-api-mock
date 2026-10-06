// Erreurs OAuth 2.0 (RFC 6749 §4.1.2.1 et §5.2). Les descriptions sont génériques et identiques
// pour toutes les causes d'un même code : elles n'indiquent jamais pourquoi un grant est refusé.

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied';

const DESCRIPTIONS: Record<OAuthErrorCode, string> = {
  invalid_request:
    'The request is missing a required parameter, includes an unsupported parameter value, or is otherwise malformed.',
  invalid_client:
    'Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.',
  invalid_grant:
    'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
  unauthorized_client: 'The client is not authorized to perform this request using this method.',
  unsupported_grant_type: 'The authorization grant type is not supported by the authorization server.',
  unsupported_response_type: 'The authorization server does not support this response type.',
  invalid_scope: 'The requested scope is invalid, unknown, or malformed.',
  access_denied: 'The resource owner or authorization server denied the request.',
};

const STATUSES: Partial<Record<OAuthErrorCode, number>> = { invalid_client: 401 };

export class OAuthError extends Error {
  readonly status: number;
  readonly description: string;

  constructor(readonly code: OAuthErrorCode) {
    super(code);
    this.status = STATUSES[code] ?? 400;
    this.description = DESCRIPTIONS[code];
  }

  toJSON(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
