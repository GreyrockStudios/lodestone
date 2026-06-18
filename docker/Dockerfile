# Lodestone — Production Docker Image
#
# Build:  docker build -t lodestone -f docker/Dockerfile .
# Run:    docker run -p 3000:3000 lodestone
# Compose: docker compose up -d

# ─── Stage 1: Build ──────────────────────────────────────────────────────────

FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for layer caching
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/cli/package.json ./packages/cli/package.json

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy source and config
COPY . .

# Build TypeScript
RUN npm run build

# Prune devDependencies — keep only production deps
RUN npm prune --omit=dev

# ─── Stage 2: Production ────────────────────────────────────────────────────

FROM node:22-slim AS production

LABEL org.opencontainers.image.title="Lodestone"
LABEL org.opencontainers.image.description="Self-improving agent runtime — memory, proactivity, and continuous improvement"
LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.source="https://github.com/greyrockstudios/lodestone"
LABEL maintainer="Greyrock Studio"

WORKDIR /app

# Install runtime dependency: curl (for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --gid 1001 lodestone && \
    useradd --uid 1001 --gid lodestone --shell /bin/bash --create-home lodestone

# Copy package manifests
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/cli/package.json ./packages/cli/package.json

# Copy production node_modules from builder (already pruned)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /app/packages/cli/node_modules ./packages/cli/node_modules

# Copy built artifacts only
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# Copy entrypoint
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create data directories and set ownership
RUN mkdir -p /app/data/safety/behavioral \
    /app/data/safety/promotion \
    /app/data/safety/intent \
    /app/data/safety/quality \
    /app/data/improvement \
    /app/data/lancedb \
    /app/data/scratch \
    /app/data/logs \
    /app/workspace/memory/wiki \
    /app/workspace/memory/raw \
    /app/workspace/memory/agents \
    /app/workspace/00-inbox \
    /app/identity \
    && chown -R lodestone:lodestone /app/data /app/workspace /app/identity

# Environment
ENV NODE_ENV=production
ENV LODESTONE_DATA_DIR=/app/data
ENV LODESTONE_WORKSPACE_DIR=/app/workspace
ENV LODESTONE_IDENTITY_DIR=/app/identity

# Ports: 3000 = web dashboard + health, 8780 = API
EXPOSE 3000 8780

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
    CMD curl -f http://localhost:3000/health || exit 1

# Volumes for persistent data
VOLUME ["/app/data", "/app/workspace", "/app/identity"]

# Switch to non-root user
USER lodestone

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "packages/cli/dist/index.js", "start"]