# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# The scanner builds this file with the repository as the build context, then runs
# its audit with no network access, so everything the build, the tests, and an
# auditor need is installed here. Dockerfile.dockerignore next to this file
# replaces the root .dockerignore for this build: the root one trims the
# production image and drops examples/ and .env.example, which the tests read.
#
# The base is the production image's: Bun at the version package.json pins, on
# the same Debian release. The framework supports both runtimes and several
# paths differ between them (HTTP serving, SQLite, DNS resolution), so Node 24
# is copied in from its image for the same Debian release; `bun run test:node`
# finds it on PATH.
FROM oven/bun:1.4.3
COPY --from=node:24-trixie-slim /usr/local/bin/node /usr/local/bin/node

# curl, jq: the field-test skill's shell helper, which the unit suite exercises,
# posts JSON-RPC with curl and parses SSE replies with jq. git: the devcheck and
# skill-version script tests run it. python3, make, g++: `bun install` compiles
# better-sqlite3 (the Node SQLite driver) with node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl jq git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Install exactly the lockfile and build as maintainers do; dist/ is what the
# published package ships.
RUN bun install --frozen-lockfile
RUN bun run build

# Run the main Vitest projects so the image is known to work. A failing test
# must not abort the build.
RUN timeout 1200 bun run test || echo "WARNING: bun run test reported failures"
