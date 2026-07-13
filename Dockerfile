FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
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
RUN npm ci --omit=dev && npm install prisma --no-save
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY backend/prisma ./prisma
COPY backend/prisma.config.ts ./
COPY backend/assets ./assets
COPY backend/scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3333
CMD ["/entrypoint.sh"]
