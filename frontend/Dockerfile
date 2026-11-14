# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app

# API base URL, substituted at build time (vite inlines VITE_* at build stage)
ARG VITE_API_BASE=/api/v1
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL

# The release pipeline asserts its selected version against package.json.
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN ERP_BUILD_TARGET=web npm run build && node scripts/verify-renderer.cjs dist web

# Stage 2: serve via nginx
FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/erp-security-headers.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80


