# Contexte de build : pennylane-api-mock/ (workspaces npm, lockfile unique)

# ---- build : compilation TypeScript ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api-server/package.json api-server/
COPY oauth-server/package.json oauth-server/
RUN npm ci -w oauth-server
COPY oauth-server/tsconfig.json oauth-server/tsconfig.build.json oauth-server/
COPY oauth-server/src oauth-server/src
RUN npm run build -w oauth-server

# ---- runtime : dépendances de production + JavaScript compilé ----
FROM node:24-alpine
ENV NODE_ENV=production OAUTH_PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY api-server/package.json api-server/
COPY oauth-server/package.json oauth-server/
RUN npm ci -w oauth-server --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/oauth-server/dist oauth-server/dist
# Données lues dans l'api-server : contextes du consentement (fixtures) et scopes Pennylane (specs)
COPY api-server/fixtures/tokens.json api-server/fixtures/db-company.json api-server/fixtures/db-firm-group.json \
  api-server/fixtures/
COPY api-server/src/server/generated/scopes-company.json api-server/src/server/generated/scopes-firm.json \
  api-server/src/server/generated/
WORKDIR /app/oauth-server
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${OAUTH_PORT}/health" || exit 1
CMD ["node", "dist/main.js"]
