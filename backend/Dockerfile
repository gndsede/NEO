FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts ./
# prisma generate só precisa resolver prisma.config.ts; não conecta ao banco.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npm run prisma:generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm install prisma --no-save
EXPOSE 3333
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
