# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to $BUILDPLATFORM rather than the target platform: `bun run build` emits
# JavaScript, and only `dist/` crosses into the production stage, which runs its
# own target-arch install. Built for the target instead, the non-native leg of a
# `--platform linux/amd64,linux/arm64` build runs under QEMU, where bun >= 1.4
# aborts with a JavaScriptCore allocator assertion and fails the multi-arch push.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
LABEL org.opencontainers.image.title="mcp-ts-core"
LABEL org.opencontainers.image.description="Agent-native TypeScript framework for MCP servers. Includes runtime infrastructure and agent skills for building, testing, and shipping servers."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/mcp-ts-core"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.cyanheads/mcp-ts-core"

# Copy dependency manifests. `bunfig.toml` rides along so every install below
# passes its release-age gate and security scanner, as a local install does.
COPY package.json bun.lock bunfig.toml ./

# The scanner bunfig.toml names is a devDependency, and Bun installs a missing
# scanner through the same production-filtered install, which omits it and
# aborts. Seed it from the build stage's full install instead.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the optional peer tiers (test runner, service SDKs,
# parsers); every package the runtime actually loads is a direct dependency.
# The OTEL step below carries the same flag — without it, that install
# re-resolves the graph and pulls every optional peer back in.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# Installed by default. Omit them for a leaner image at build time
# with: docker build --build-arg OTEL_ENABLED=false
# These packages are this project's own peers, so `bun add` would keep them
# as peers and `--omit=peer` would skip them. Instead the image's package.json
# moves each one into `dependencies` at its `peerDependencies` range, keeping
# the resolution inside the tested peer range, and the reinstall below installs
# them through bunfig.toml's release-age gate and scanner while every other
# optional peer stays omitted. A name with no declared range fails the build.
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun -e ' \
        const pkg = await Bun.file("package.json").json(); \
        const names = process.argv.slice(1); \
        const missing = names.filter((name) => !pkg.peerDependencies?.[name]); \
        if (missing.length > 0) throw new Error(`no peerDependencies range for ${missing.join(", ")}`); \
        for (const name of names) { \
          pkg.dependencies[name] = pkg.peerDependencies[name]; \
          delete pkg.peerDependencies[name]; \
          delete pkg.peerDependenciesMeta?.[name]; \
          delete pkg.devDependencies?.[name]; \
        } \
        await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`); \
      ' \
        @hono/otel \
        @opentelemetry/api-logs \
        @opentelemetry/exporter-logs-otlp-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-logs \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions \
      && bun install --production --omit=peer --ignore-scripts; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/mcp-ts-core && chown -R bun:bun /var/log/mcp-ts-core

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/mcp-ts-core"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
