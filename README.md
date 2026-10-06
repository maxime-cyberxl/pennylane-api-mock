# pennylane-api-mock

Un **faux Pennylane** à lancer en local, pour développer une intégration sans toucher au vrai.

* Il répond comme Pennylane : mêmes URL, mêmes champs, même pagination, mêmes filtres.
* Il gère la **connexion OAuth 2.0** comme Pennylane : page d'autorisation, échange du code, refresh token à usage unique, révocation.
* Les données sont **réalistes et cohérentes** : une facture payée a bien sa transaction bancaire, ses écritures équilibrées, son lettrage…
* Elles sont **persistantes** : ce que vous créez ou modifiez est conservé jusqu'au `npm run reset`.

Le jour où vous passez sur le vrai Pennylane, **seule la configuration change** :

| | Mock | Pennylane |
|---|---|---|
| URL de base | `http://localhost:3000` | `https://app.pennylane.com` |
| Client ID | `pennylane-poc` | fourni par Pennylane |
| Client Secret | `pennylane-poc-secret` | fourni par Pennylane |

## Démarrer

```bash
cd pennylane-api-mock
docker compose up
```

Tout est disponible sur **http://localhost:3000** :

| Chemin | Rôle |
|---|---|
| `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | la connexion OAuth 2.0 |
| `/api/external/v2/...` | API Company v2 : un dossier (une entreprise) |
| `/api/external/firm/v1/...` | API Firm v1 : un cabinet comptable et ses dossiers |
| `/api/firm/v3/...` | API Firm group v3 : gestion des cabinets, utilisateurs, dossiers |
| `/health` | répond `{"status":"ok"}` |

Le `docker-compose.yml` à la racine de `pennylane-toolbox` inclut celui-ci : un `docker compose up` à la racine lance aussi les mocks.

Sans Docker (Node.js 24) :

```bash
npm install            # une seule fois
npm run start:api      # les 3 API (ports 4010 à 4012)
npm run dev:oauth      # le serveur OAuth sur le port 3000, à lancer en même temps
```

## Comment c'est construit

Deux petits serveurs travaillent ensemble :

```mermaid
flowchart LR
    S[Votre application<br/>Symfony, Postman…] -->|tout passe par<br/>localhost:3000| O[oauth-server<br/>port 3000]
    O -->|/api/... relayé tel quel| A[api-server<br/>ports 4010-4012]
    A -.->|« ce token est-il valide ? »| O
```

* **oauth-server** (port 3000) : la porte d'entrée. Il gère `/oauth/*` et relaie les appels d'API vers l'api-server, sans les modifier.
* **api-server** (ports 4010 à 4012) : les 3 API et leurs données. Pour un token qu'il ne connaît pas, il demande à l'oauth-server s'il est valide, à quel dossier il donne accès et avec quels scopes.

Vous pouvez aussi appeler l'api-server directement (`http://localhost:4010/api/external/v2/...`), les mêmes tokens y fonctionnent.

## Se connecter avec OAuth, étape par étape

### 1. Envoyer l'utilisateur sur la page d'autorisation

```
http://localhost:3000/oauth/authorize?client_id=pennylane-poc&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fpennylane%2Fcallback&response_type=code&scope=customers%3Areadonly%20customer_invoices%3Areadonly&state=abc123
```

| Paramètre | Obligatoire | Valeur |
|---|---|---|
| `client_id` | oui | `pennylane-poc` |
| `redirect_uri` | oui | exactement celle enregistrée : `http://localhost:8000/pennylane/callback` |
| `response_type` | oui | `code` |
| `scope` | oui | scopes séparés par des **espaces** (pas des virgules), voir [Les scopes](#les-scopes) |
| `state` | non, mais utilisez-le | une valeur aléatoire, renvoyée telle quelle |

### 2. L'utilisateur choisit un dossier et autorise

La page propose les dossiers et le cabinet de l'api-server. Choisir un contexte connecte son utilisateur, sans mot de passe :

| Contexte | Nom | Utilisateur | Type de token |
|---|---|---|---|
| `company:101` | Atelier Lumière | Claire Lefèvre | Company : un seul dossier |
| `company:102` | Boulangerie Le Fournil Doré | Antoine Mercier | Company |
| `company:103` | Kiné Fontaine | Claire Fontaine | Company |
| `company:104` | Holding Delmas | Étienne Delmas | Company |
| `firm:1` | Cabinet Delmas & Associés | Hélène Delmas | Firm : les dossiers 101 à 104 |

Puis il clique sur **Autoriser** ou **Refuser**.

### 3. Le callback

Le navigateur est renvoyé vers votre `redirect_uri` :

| Choix | Redirection |
|---|---|
| Autoriser | `http://localhost:8000/pennylane/callback?code=…&state=abc123` |
| Refuser | `http://localhost:8000/pennylane/callback?error=access_denied&state=abc123` |
| Scope inconnu | `…?error=invalid_scope&state=abc123` |

Le callback est **une route de votre application**, pas du mock. Le mock y envoie simplement le navigateur. Cette route doit :

1. si `error` est présent : afficher « connexion refusée » et s'arrêter ;
2. vérifier que `state` est celui mis en session au départ (sinon : 403) ;
3. échanger tout de suite le `code` contre des tokens (étape 4). **Le code ne vit que 60 secondes et ne sert qu'une fois** ;
4. stocker l'access token et le refresh token côté serveur, jamais dans le navigateur.

Vous testez sans votre application ? Le navigateur arrive sur `localhost:8000` et affiche une erreur de connexion : c'est normal. Le `code` est dans la barre d'adresse : copiez-le et faites l'étape 4 en moins de 60 secondes.

> Le mock refuse un `redirect_uri` qui n'est pas exactement celui enregistré : il affiche une page d'erreur et **ne redirige pas**. Pour en ajouter un, voir `OAUTH_REDIRECT_URI` dans [Configuration](#configuration).

### 4. Échanger le code contre des tokens

```bash
curl -X POST http://localhost:3000/oauth/token \
  -d "client_id=pennylane-poc" \
  -d "client_secret=pennylane-poc-secret" \
  -d "code=LE_CODE" \
  -d "redirect_uri=http://localhost:8000/pennylane/callback" \
  -d "grant_type=authorization_code"
```

```json
{
  "access_token": "kX0…",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "p7Q…"
}
```

`client_id` et `client_secret` vont **dans le corps** de la requête, en `application/x-www-form-urlencoded`, comme le demande Pennylane. Un en-tête `Authorization: Basic` est refusé (`401 invalid_client`).

### 5. Appeler l'API

```bash
curl http://localhost:3000/api/external/v2/me -H "Authorization: Bearer ACCESS_TOKEN"
curl "http://localhost:3000/api/external/v2/customer_invoices?limit=2" -H "Authorization: Bearer ACCESS_TOKEN"
```

Avec un **firm token**, choisissez le dossier avec l'en-tête `X-Company-Id` sur l'API Company, ou avec l'id dans l'URL sur l'API Firm :

```bash
curl http://localhost:3000/api/external/v2/customers -H "Authorization: Bearer ACCESS_TOKEN" -H "X-Company-Id: 102"
curl http://localhost:3000/api/external/firm/v1/companies -H "Authorization: Bearer ACCESS_TOKEN"
```

L'access token est valable **24 heures**.

### 6. Renouveler les tokens (refresh)

```bash
curl -X POST http://localhost:3000/oauth/token \
  -d "client_id=pennylane-poc" \
  -d "client_secret=pennylane-poc-secret" \
  -d "refresh_token=REFRESH_TOKEN" \
  -d "grant_type=refresh_token"
```

Vous recevez **un nouvel access token et un nouveau refresh token**. Les anciens sont morts tout de suite : l'ancien access token renvoie 401, l'ancien refresh token renvoie `invalid_grant`. C'est la « rotation » de Pennylane : `A → B → C…`, jamais `A → A`.

Conséquence pour votre application : deux refresh simultanés avec le même token, et le second échoue. Il faut un verrou, puis enregistrer les deux nouveaux tokens d'un coup.

Le refresh token est valable 90 jours.

### 7. Révoquer

```bash
curl -i -X POST http://localhost:3000/oauth/revoke \
  -d "client_id=pennylane-poc" \
  -d "client_secret=pennylane-poc-secret" \
  -d "token=ACCESS_OU_REFRESH_TOKEN"
# HTTP/1.1 200 OK, corps vide
```

Révoquer l'access token révoque aussi son refresh token, et inversement.

## Les erreurs

| Situation | Réponse |
|---|---|
| mauvais `client_id` ou `client_secret` | `401 {"error":"invalid_client"}` |
| code inconnu, expiré, déjà utilisé, ou mauvais `redirect_uri` | `400 {"error":"invalid_grant"}` |
| refresh token déjà utilisé, révoqué ou expiré | `400 {"error":"invalid_grant"}` |
| `grant_type` inconnu | `400 {"error":"unsupported_grant_type"}` |
| API sans token, ou token inconnu | `401 {"status":401,"error":"The access token is invalid"}` |
| API avec un token expiré | `401 … "The access token expired"` |
| API avec un token révoqué ou remplacé par un refresh | `401 … "The access token was revoked"` |
| API avec un scope manquant | `403 … "Missing scope: one of …"` |
| firm token sur un dossier hors portefeuille | `403` |

Les erreurs OAuth contiennent aussi un `error_description` générique : il ne dit jamais *pourquoi* un code ou un token est refusé.

## Tester avec Postman

Onglet **Authorization**, type **OAuth 2.0** :

| Champ | Valeur |
|---|---|
| Grant type | Authorization Code |
| Callback URL | `http://localhost:8000/pennylane/callback` |
| Auth URL | `http://localhost:3000/oauth/authorize` |
| Access Token URL | `http://localhost:3000/oauth/token` |
| Client ID / Client Secret | `pennylane-poc` / `pennylane-poc-secret` |
| Scope | par ex. `customers:readonly customer_invoices:readonly` |
| **Client Authentication** | **Send client credentials in body** (sinon : 401) |

Postman ouvre la page d'autorisation dans sa propre fenêtre et récupère lui-même le `code` au moment du callback : rien n'a besoin de tourner sur `localhost:8000`. Si vous cochez **Authorize using browser**, Postman utilise `https://oauth.pstmn.io/v1/callback` comme callback : ajoutez-la à `OAUTH_REDIRECT_URI`.

Envoyez ensuite vos requêtes sur `http://localhost:3000/api/...`. Remplacez les valeurs d'exemple des specs : par exemple `/companies/string` par `/companies/101`.

## Les jetons statiques (sans OAuth)

Pour aller vite, l'API accepte aussi des jetons fixes, sur `localhost:3000` comme sur les ports 4010 à 4012 :

| Jeton | Accès |
|---|---|
| `mock_company_101_full` | dossier 101 (Atelier Lumière), tous les droits |
| `mock_company_102_full`, `_103_full`, `_104_full` | dossiers Fournil Doré, Kiné Fontaine, Holding |
| `mock_company_101_readonly` | dossier 101, lecture seule (un `POST` renvoie 403) |
| `mock_company_101_invoices` | dossier 101, uniquement factures clients et clients (pour tester les 403) |
| `mock_firm_1_full` / `mock_firm_1_readonly` | cabinet Delmas & Associés : dossiers 101 à 104 |
| `mock_firm_group_full` | API Firm group |

```bash
curl -H "Authorization: Bearer mock_company_101_full" "http://localhost:3000/api/external/v2/customers?limit=2"
```

Comme sur Pennylane, **le jeton détermine ce que vous voyez** :

| Type de jeton | Rattaché à | Pour cibler un dossier | Accepté sur |
|---|---|---|---|
| **Company** | 1 seul dossier | rien : le dossier est implicite | API Company |
| **Firm** | tous les dossiers du cabinet | en-tête `X-Company-Id: <id>` (API Company) ou id dans l'URL (API Firm) | API Company + API Firm |
| **Firm group** | le groupe de cabinets | — | API Firm group |

Pour désactiver toute vérification (le dossier 101 est alors utilisé par défaut) : `MOCK_AUTH=off`.

## Les scopes

Ce sont ceux des specs Pennylane, par exemple `customers:readonly`, `customers:all`, `customer_invoices:readonly`, `companies:readonly`… La liste complète est dans `api-server/src/server/generated/scopes-company.json` et `scopes-firm.json`.

* `:readonly` donne la lecture, `:all` la lecture et l'écriture.
* Un scope inconnu est refusé dès la page d'autorisation (`invalid_scope`).
* Les scopes accordés suivent le token, refresh compris. L'API répond 403 s'il en manque un.

## Les données

Un cabinet fictif, *Delmas & Associés*, et ses clients. Le dossier principal est **Atelier Lumière** (agence web, id 101) : janvier 2025 → septembre 2026, avec clients, fournisseurs, factures, devis, banque, TVA, paie. Les autres dossiers (boulangerie, kiné, holding…) sont plus légers. Les identifiants sont les mêmes dans toutes les API. « Aujourd'hui » vaut toujours le 30/09/2026.

Quelques exemples utiles pour tester : factures en retard (`status=late`), facture partiellement payée, avoir, brouillon, devis facturé, abonnements, écritures lettrées.

```bash
H="Authorization: Bearer mock_company_101_full"
curl -H "$H" -G "http://localhost:3000/api/external/v2/customer_invoices" \
  --data-urlencode 'filter=[{"field":"status","operator":"eq","value":"late"}]'
curl -H "$H" "http://localhost:3000/api/external/v2/trial_balance?period_start=2026-01-01&period_end=2026-12-31"
```

## Ce qui est géré / pas géré

* Lecture (`GET`) de toutes les ressources, avec `limit`/`cursor` (ou `page`/`per_page`), `filter`, `sort`, sous-ressources (`/customer_invoices/1/invoice_lines`…).
* `trial_balance` calculée à partir des écritures ; `public_file_url` sert un PDF de démo ; `/exports/fecs/:id/fec.txt` sert un vrai FEC.
* `POST`, `PUT`, `DELETE` : l'objet est simplement enregistré (ou modifié) tel que vous l'envoyez. Pas de calcul automatique (écritures, numéro de facture…), et les actions (`finalize`, `mark_as_paid`, `send_by_email`…) ne sont pas simulées.
* OAuth : pas de PKCE (Pennylane ne le mentionne pas). Les codes et tokens sont gardés **en mémoire** : redémarrer l'oauth-server oblige à refaire la connexion, comme si Pennylane avait révoqué l'accès.

## Configuration

Tout a une valeur par défaut. Pour changer quelque chose, copiez `.env.example` en `.env`, dans ce dossier. Le même fichier sert aux deux serveurs, avec Docker comme avec npm.

| Variable | Défaut | Rôle |
|---|---|---|
| `OAUTH_CLIENT_ID` | `pennylane-poc` | identifiant du client OAuth |
| `OAUTH_CLIENT_SECRET` | `pennylane-poc-secret` | secret du client (jamais affiché ni journalisé) |
| `OAUTH_REDIRECT_URI` | `http://localhost:8000/pennylane/callback` | callbacks acceptées, séparées par des espaces |
| `OAUTH_ALLOWED_SCOPES` | tous les scopes des specs | scopes que le client peut demander |
| `ACCESS_TOKEN_TTL` | `86400` (24 h) | durée de vie de l'access token, en secondes |
| `REFRESH_TOKEN_TTL` | `7776000` (90 jours) | durée de vie du refresh token |
| `AUTHORIZATION_CODE_TTL` | `60` | durée de vie du code |
| `OAUTH_MOCK_HOST_PORT` | `3000` | port publié par Docker |
| `MOCK_AUTH` | `on` | `off` : l'API ne vérifie plus les jetons |

Plus rarement (adresses entre les deux serveurs, déjà réglées pour Docker) : `API_SERVER_HOST`, `OAUTH_INTROSPECTION_URL`, `API_SERVER_DIR`, `OAUTH_PORT`, `MOCK_HOST`. Voir `.env.example`.

## Côté Symfony

```env
PENNYLANE_BASE_URL=http://localhost:3000
PENNYLANE_CLIENT_ID=pennylane-poc
PENNYLANE_CLIENT_SECRET=pennylane-poc-secret
PENNYLANE_REDIRECT_URI=http://localhost:8000/pennylane/callback
```

Avec `league/oauth2-client`, construisez toutes les URLs à partir de `PENNYLANE_BASE_URL` :

```php
$provider = new GenericProvider([
    'clientId'                => $_ENV['PENNYLANE_CLIENT_ID'],
    'clientSecret'            => $_ENV['PENNYLANE_CLIENT_SECRET'],
    'redirectUri'             => $_ENV['PENNYLANE_REDIRECT_URI'],
    'urlAuthorize'            => $_ENV['PENNYLANE_BASE_URL'].'/oauth/authorize',
    'urlAccessToken'          => $_ENV['PENNYLANE_BASE_URL'].'/oauth/token',
    'urlResourceOwnerDetails' => $_ENV['PENNYLANE_BASE_URL'].'/api/external/v2/me',
    'scopeSeparator'          => ' ', // la lib met des virgules par défaut : refusé
]);
// Appels d'API : {PENNYLANE_BASE_URL}/api/external/v2/...
// Révocation : POST {PENNYLANE_BASE_URL}/oauth/revoke (client_id, client_secret, token)
```

Pour passer sur Pennylane : changez l'URL, l'ID et le secret, et déclarez votre callback de production auprès de Pennylane.

## Ce que la doc Pennylane ne dit pas

Le mock a dû faire des choix. Ils sont à confirmer avec Pennylane (voir `docs/guide_oauth2_pennylane.pdf`, section 9) :

| Question | Choix du mock |
|---|---|
| Révoquer l'access token révoque-t-il le refresh token ? | oui, dans les deux sens |
| Les 90 jours du refresh token repartent-ils à chaque rotation ? | oui |
| Plusieurs callbacks possibles ? | oui, comparaison exacte |
| Comment un firm token choisit-il son dossier ? | comme l'api-server : `X-Company-Id` ou id dans l'URL |
| Rejouer un ancien refresh token coupe-t-il toute la connexion ? | non, seul ce token est refusé |

## Tester

```bash
npm test                              # tests des deux serveurs
npm run verify:e2e -w oauth-server    # le parcours complet contre les mocks lancés
```

Le parcours complet enchaîne : autorisation, code, token, appels d'API, expiration, refresh, rotation, ancien refresh refusé, révocation. Pour voir l'expiration sans attendre 24 h, mettez `ACCESS_TOKEN_TTL=5` dans `.env` puis relancez `docker compose up --build`.

## Organisation du dossier

```
package.json, package-lock.json   workspaces npm : un seul npm install, un seul node_modules
.env.example                      configuration commune
docker-compose.yml                les deux services
api-server/                       les 3 API (json-server)
  specs/                            les 3 specs OpenAPI officielles (la référence)
  fixtures/                         les données fournies : db-*.json, tokens.json, factures de démo
  src/server/                       le serveur, et la vérification des jetons (statiques ou OAuth)
  src/generator/                    le programme qui fabrique fixtures/ à partir des specs
oauth-server/                     OAuth 2.0 et porte d'entrée (TypeScript, Express)
  src/oauth/                        la logique OAuth : autorisation, tokens, rotation, révocation
  src/storage/                      le stockage des codes et tokens (en mémoire)
  src/http/                         les routes : /oauth/*, relais des API, introspection
  src/api-server/                   lecture des dossiers, utilisateurs et scopes de l'api-server
  test/, scripts/                   tests automatisés, parcours complet
```

L'api-server copie les `db-*.json` de `fixtures/` vers `.db/` et travaille sur cette copie : vos `POST`/`PUT`/`DELETE` y sont conservés, `fixtures/` reste intact. `npm run reset -w api-server` supprime la copie.

Pour garder les tokens ailleurs qu'en mémoire (Redis, PostgreSQL), il suffit d'écrire une autre version des trois interfaces de `oauth-server/src/storage/` et de la brancher dans `oauth-server/src/container.ts`.

## Modifier ou régénérer les données

Les fichiers de `api-server/fixtures/` sont **générés** : ne les éditez pas à la main. Modifiez `src/generator/profiles.mjs` (clients, fournisseurs, produits, dates) ou `company-gen.mjs` (règles comptables), puis :

```bash
npm run generate -w api-server    # régénère fixtures/, puis vérifie : conformité aux specs + cohérence comptable
npm test -w api-server            # démarre les 3 serveurs et teste chaque endpoint GET de la spec
```

La page d'autorisation suit automatiquement : elle lit les dossiers et utilisateurs dans les fixtures au démarrage.

Comment c'est fabriqué, en bref : `extract.mjs` lit les specs (`openapi-sampler`) → `build.mjs` génère les données avec un petit moteur comptable déterministe (mêmes données à chaque exécution) → `validate.mjs` contrôle tout.

## Limites connues

* `transfer_requests/list_inbound|outbound` (Firm group) : la spec décrit un objet unique, le mock renvoie une liste.
* Si une spec déclare un champ `nullable` avec une liste de valeurs sans `null`, le mock renvoie `null` (comportement documenté de l'API).
