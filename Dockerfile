# PLAN.md §10 — node:22, matching the compose stack.
FROM node:22-slim AS build

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
RUN npx prisma generate

COPY src ./src
RUN npm run build


FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# The generated client lives in node_modules, so it is copied rather than regenerated.
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
