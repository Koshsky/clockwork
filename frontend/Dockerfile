# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app

# API base URL, substituted at build time (vite inlines VITE_* at build stage)
ARG VITE_API_BASE=/api/v1
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

# Semantic version of the release (SemVer tag, e.g. v1.0.1); baked into the
# bundle (__APP_VERSION__) and dist/precache-manifest.json via vite
# (buildVersion in vite.config.ts). Default "dev" for ad-hoc builds; the
# release pipeline passes the tag, e.g. --build-arg APP_VERSION=v1.0.1.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve via nginx
FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/erp-security-headers.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80


