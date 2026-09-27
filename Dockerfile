# ---- build stage: compile the static React/Vite app ----
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts vitest.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- verify stage: one-shot acceptance (test suite + type check + build) ----
FROM node:20-alpine AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts vitest.config.ts index.html ./
COPY src ./src
# Exits non-zero on any failure so `docker compose run --rm verify` reports
# the acceptance result honestly; no fixed/mocked responses are involved.
CMD ["npm", "run", "verify"]

# ---- web stage: serve the static build with nginx ----
FROM nginx:1.27-alpine AS web
# The official nginx image runs envsubst over /etc/nginx/templates/*.template
# on startup, producing /etc/nginx/conf.d/default.conf with $WEB_PORT.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV WEB_PORT=8080
EXPOSE 8080
