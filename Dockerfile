FROM node:22-bookworm-slim AS base
WORKDIR /app
# util-linux traz o setpriv, usado pelo entrypoint para largar o root depois de
# ajustar o dono do volume de uploads. Já vem na imagem base do Debian; fica
# explícito para que uma troca de imagem não quebre o boot em silêncio.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates util-linux \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

FROM deps AS build
COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./
# prisma generate só precisa resolver prisma.config.ts; não conecta ao banco.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run prisma:generate
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
# Versão do prisma CLI fixada na mesma do lockfile (CWE-1104 — build reprodutível).
# Ao atualizar o prisma no package.json, atualize também aqui.
RUN npm ci --omit=dev && npm install prisma@7.8.0 --no-save
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./
COPY backend/assets ./assets
COPY backend/scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Defesa em profundidade (CIS Docker Benchmark 4.1): o processo Node roda como
# usuário sem privilégios — uma RCE via dependência não ganha root no container.
# O container inicia como root e o entrypoint larga o privilégio com setpriv:
# um volume montado em /app/uploads nasce pertencendo a root, e sem o chown
# prévio todo upload falharia com EACCES. Node nunca chega a rodar como root.
RUN useradd --system --uid 1001 --create-home appuser \
  && mkdir -p /app/uploads \
  && chown -R appuser:appuser /app/uploads /home/appuser
EXPOSE 3333
CMD ["/entrypoint.sh"]
