# syntax=docker/dockerfile:1
#
# One image, every surface. The default command runs the server, which serves
# the web UI at /, the search API at /api (and at the root), and MCP at /mcp —
# so there is no reverse proxy and no CORS to configure.
#
#   docker build -t searchicus .
#
#   docker run --rm --init --shm-size=1g -p 3000:3000 \
#     -v searchicus-api-profile:/profiles/api \
#     searchicus
#
#   docker run --rm --init --shm-size=1g \
#     -e SEARCHICUS_PROFILE_DIR=/profiles/cli \
#     -v searchicus-cli-profile:/profiles/cli \
#     searchicus node packages/cli/dist/index.js search "typescript generics"
#
# Three flags are not optional for a container that drives Chromium:
#
#   --init          Chromium spawns many child processes. With no init process
#                   to reap them, zombies pile up in a container meant to run
#                   for days.
#   --shm-size=1g   Docker's default /dev/shm is 64MB. Chromium leans on shared
#                   memory and dies with opaque renderer crashes without this.
#   -v ...:/profiles/...
#                   The Chromium profile is the whole point of the browser
#                   layer: it carries cookies, dismissed consent banners, and
#                   cache between searches and across restarts. Without a
#                   volume it lives in the container's writable layer and is
#                   silently discarded — degrading to a cold profile on every
#                   run, with no error to tell you.
#
# Also give it time to stop. The server drains live browser sessions for up to
# 15s, but `docker stop` SIGKILLs after 10s: use `docker stop -t 30`.
#
# Never bind-mount a host directory for the profile. Chromium profiles are
# SQLite databases, and SQLite locking over virtiofs/9p (a macOS or Windows
# bind mount) is unreliable; a profile written by one platform's Chromium is
# not valid for another's. Use a named volume.

# =============================================================================
# Build stage
# =============================================================================
FROM node:22-bookworm-slim AS build

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
RUN mkdir -p /profiles/api /profiles/cli && chown -R pwuser:pwuser /profiles
ENV SEARCHICUS_PROFILE_DIR=/profiles/api

# Chromium's sandbox refuses to run as root, and --no-sandbox is a real
# downgrade for a process that renders untrusted pages.
USER pwuser

EXPOSE 3000

# Node 22 ships a global fetch, so this needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "packages/api/dist/index.js"]
