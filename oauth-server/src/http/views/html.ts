const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Échappe une valeur avant insertion dans du HTML (contenu ou attribut). */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

/** Pas de script, pas d'iframe : la page ne charge rien et ne peut pas être embarquée. */
export const PAGE_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

export const layout = (title: string, body: string): string => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --accent: #0f6e56; --muted: #6b7280; --line: #d1d5db; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .badge { display: inline-block; font-size: .75rem; padding: .1rem .5rem; border-radius: 1rem; background: #fde68a; color: #78350f; }
  fieldset { border: 1px solid var(--line); border-radius: .5rem; margin: 0 0 1rem; padding: .75rem 1rem 1rem; }
  legend { font-weight: 600; padding: 0 .25rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .75rem; margin: 0; }
  dt { color: var(--muted); } dd { margin: 0; word-break: break-all; }
  code { font-size: .9em; }
  label { display: block; margin: .25rem 0; }
  input[type=email] { width: 100%; box-sizing: border-box; padding: .4rem; }
  .actions { display: flex; gap: .75rem; }
  button { flex: 1; padding: .6rem; border-radius: .4rem; border: 1px solid var(--accent); font-size: 1rem; cursor: pointer; }
  button[value=approve] { background: var(--accent); color: #fff; }
  button[value=deny] { background: transparent; color: inherit; }
  .muted { color: var(--muted); font-size: .875rem; }
  .group { font-weight: 600; margin: .75rem 0 .25rem; }
</style>
</head>
<body>
<p><span class="badge">Mock local — pas le vrai Pennylane</span></p>
${body}
</body>
</html>`;
