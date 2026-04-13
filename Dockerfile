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

ENV NODE_ENV=production

# pg (node-postgres) needs libpq for native bindings
RUN apk add --no-cache postgresql-client

# Copy only production dependency manifests
COPY package*.json ./

# Install production deps only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/supabase ./supabase

# Expose the default port
EXPOSE 3000

# Health check (used by Docker + orchestrators)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start the Express server
CMD ["node", "server/index.js"]
