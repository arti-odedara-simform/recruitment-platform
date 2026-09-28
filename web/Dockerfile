# The frontend half of `docker compose up`. Two stages: build the bundle with the same
# node:22 as the API, then serve the static output from nginx — the runtime image carries
# no Node, no node_modules and no source.
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

# `src/api/types.ts` is committed, so this build never needs a running API to typecheck
# against. Regenerating it is a development step (`npm run api:types`), not a build step.
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build


FROM nginx:alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
