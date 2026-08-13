# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (cache layer)
COPY package*.json ./

# Install ALL deps (dev included — needed for vite + tsc)
RUN npm ci

# Copy source
COPY . .

# Build: frontend (Vite) + backend TypeScript
RUN npm run build

# ── Stage 2: Production runtime ─────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Repository identity for the deployment parity gate
# (REPO_SHA == APP_SHA == RUNNER_SHA). Pass the FULL 40-character SHA:
#   docker build --build-arg APP_GIT_SHA="$(git rev-parse HEAD)" .
# An abbreviated or missing value is reported by /api/build-info as
# gitSha: null — honestly unknown, which fails the gate.
ARG APP_GIT_SHA=""
ENV APP_GIT_SHA=$APP_GIT_SHA

ENV NODE_ENV=production
# Force IPv4 DNS — container networks on Dublyo don't support IPv6
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
# NOTE: no NODE_TLS_REJECT_UNAUTHORIZED=0 here. Self-signed PostgreSQL
# certificates are accepted by the narrowly scoped `ssl` config inside
# backend/src/lib/db.ts and scripts/migrate.js (sslmode-aware,
# rejectUnauthorized:false for the DB connection only). All other outbound
# TLS (audited sites, APIs) is verified normally.

# pg (node-postgres) needs libpq for native bindings
RUN apk add --no-cache postgresql-client

# Copy only production dependency manifests
COPY package*.json ./

# Install production deps only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder stage
# .env is deliberately NOT copied — the platform injects DATABASE_URL and
# friends; baking credentials into the image is a leak vector.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/supabase ./supabase

# Expose the default port
EXPOSE 3000

# Health check (used by Docker + orchestrators)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start the Express server
CMD ["node", "server/index.js"]
