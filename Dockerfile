# Base image pinned by digest, not just by tag.
#
# `node:22-alpine` is a moving target: the same tag silently becomes a different
# image, so an image that passed review is not necessarily the one that ships.
# Digest resolved from the tag on 2026-08-21. To update deliberately:
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.oci.image.index.v1+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/22-alpine | grep -i docker-content-digest
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---------------------------------------------------------------------------
# Build stage: compile TypeScript to JavaScript.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts/build.mjs ./scripts/
COPY src ./src

# Typecheck in the image too. A build that compiles but would not typecheck is
# not a build worth shipping, and CI is not the only place this gets built.
RUN npm run typecheck && npm run build

# ---------------------------------------------------------------------------
# Runtime stage: production dependencies and compiled output only.
# No TypeScript, no tsx, no build toolchain.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV ARTIFACT_DIR=/data/artifacts

COPY package.json package-lock.json ./
# `type: module` in package.json is what makes Node read dist/*.js as ESM,
# so package.json has to be here, not just in the build stage.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Runtime assets. src/paths.ts resolves these relative to the app root, and
# dist/ sits at the same depth src/ did, so the layout matches the dev tree.
COPY migrations ./migrations
COPY templates ./templates
COPY prompts ./prompts
COPY contracts ./contracts
COPY config ./config
COPY fixtures ./fixtures

# Run as an unprivileged user. The `node` user (uid 1000) ships with the base
# image. /data is created and handed over while we are still root.
RUN mkdir -p /data/artifacts && chown -R node:node /data /app
USER node

EXPOSE 8787

# Fastify binds 0.0.0.0; probe over loopback so the check does not depend on
# the container's external address. Node's built-in fetch avoids installing
# curl just to answer this question.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p=process.env.PORT||8787;fetch('http://127.0.0.1:'+p+'/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
