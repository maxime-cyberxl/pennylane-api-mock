# Contexte de build : pennylane-api-mock/ (workspaces npm, lockfile unique)
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY api-server/package.json api-server/
COPY oauth-server/package.json oauth-server/
RUN npm ci -w api-server --omit=dev && npm cache clean --force
COPY api-server/ api-server/
WORKDIR /app/api-server
ENV MOCK_HOST=0.0.0.0
EXPOSE 4010 4011 4012
CMD ["npm", "start"]
