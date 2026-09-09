# syntax=docker/dockerfile:1
#
# One image, every surface. The default command runs the server, which serves
# the web UI at /, the search API at /api (and at the root), and MCP at /mcp —
# so there is no reverse proxy and no CORS to configure.
#
#   docker build -t searchicus .
#
#   docker run --rm --init --shm-size=1g -p 3000:3000 \
#     -v searchicus-data:/data \
#     searchicus
#
#   docker run --rm --init --shm-size=1g \
#     -v searchicus-data:/data \
#     searchicus node packages/cli/dist/index.js search "typescript generics"
#
# Three flags are not optional for a container that drives Chromium:
#
#   --init          Chromium spawns many child processes. With no init process
#                   to reap them, zombies pile up in a container meant to run
#                   for days.
#   --shm-size=1g   Docker's default /dev/shm is 64MB. Chromium leans on shared
#                   memory and dies with opaque renderer crashes without this.
#   -v ...:/data
#                   The persistent data root contains isolated Chromium
#                   profiles and the shared search archive. Without a volume
#                   both live in the container's writable layer and are
#                   silently discarded on replacement — degrading to a cold
#                   profile and losing search history.
#
# Also give it time to stop. The server drains live browser sessions for up to
# 15s, but `docker stop` SIGKILLs after 10s: use `docker stop -t 30`.
#
# Never bind-mount a host directory for the data root. Chromium profiles are
# SQLite databases, and SQLite locking over virtiofs/9p (a macOS or Windows
# bind mount) is unreliable; a profile written by one platform's Chromium is
# not valid for another's. Use a named volume.

# =============================================================================
# Build stage
# =============================================================================
# Same major as the runtime image below. They are different bases for good
# reasons, but a project that declares a Node floor has to be built on a Node
# that meets it: `.npmrc` sets engine-strict, so a lower major here fails at
# `npm ci` rather than producing something subtly different.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Playwright's postinstall would fetch ~1GB of browsers this stage only throws
# away; the runtime image already ships them at a matching revision.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Manifests first, so `npm ci` stays cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/ui/package.json packages/ui/
RUN npm ci

COPY . .
RUN npm run build

# Drop devDependencies. Everything left is plain JavaScript (playwright-core,
# express, zod, the MCP SDK, commander), so nothing needs recompiling for the
# differently-based runtime image. Verified to keep the workspace symlinks in
# node_modules/@searchicus/* intact, which the built output resolves through.
RUN npm prune --omit=dev


# =============================================================================
# Runtime stage
# =============================================================================
# Pinned to match `playwright` in packages/core/package.json: the image's
# bundled Chromium must be the revision this client expects, and a mismatch
# fails at launch rather than at build. Bump the two together.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Copied wholesale rather than dist-by-dist: npm workspaces symlinks
# node_modules/@searchicus/* back to packages/*, and rebuilding those links
# piecemeal is far more fragile than carrying a few hundred KB of source along.
COPY --from=build --chown=pwuser:pwuser /app /app

# Pre-created so a fresh named volume inherits pwuser ownership — Docker seeds
# an empty volume from the image's directory, permissions included. Without
# this the mount lands root-owned and the non-root process cannot write it.
RUN mkdir -p /data/profile/api /data/profile/cli && chown -R pwuser:pwuser /data
ENV SEARCHICUS_PATHS_DATA_DIR=/data
# The server binds loopback by default, which inside a container means
# nothing outside it can connect. A published port needs all interfaces.
ENV SEARCHICUS_SERVER_HOST=0.0.0.0

# Chromium's sandbox refuses to run as root, and --no-sandbox is a real
# downgrade for a process that renders untrusted pages.
USER pwuser

EXPOSE 3000

# The image's Node ships a global fetch, so this needs no curl in it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "packages/api/dist/index.js"]
