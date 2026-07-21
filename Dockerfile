FROM node:22.17.0-alpine3.22 AS runtime
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.8.0 --activate

# Copy package manifest and install all deps (--prod for runtime, but keep TypeScript dev for --experimental-transform-types)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy server source code
COPY tsconfig.json ./
COPY src/server/ ./src/server/
COPY src/drizzle/ ./src/drizzle/

# Create data dir for ML models
RUN mkdir -p /app/data /app/models

EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://localhost:9090/health || exit 1

CMD ["pnpm", "exec", "tsx", "src/server/execution/server.ts"]
