FROM node:18-alpine

# Build args injected at image build time. They become env vars at runtime
# via ENV below so /health/version can return them.
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=dev

ENV GIT_SHA=${GIT_SHA} \
    GIT_REF=${GIT_REF} \
    BUILD_TIME=${BUILD_TIME} \
    IMAGE_TAG=${IMAGE_TAG} \
    NODE_ENV=production

# git + docker-cli + bash are only used by the admin-bot container which
# shells out to `bin/upgrade` (which in turn calls `docker compose`). They
# are unused in the regular backend container and add ~30 MB. Worth it for
# the operational simplicity of one image.
#
# python3 / make / g++ are required to build native deps (notably bcrypt)
# from source against musl libc. The published bcrypt prebuilds target
# glibc-based distros and segfault at runtime on alpine — see the
# `napi_get_cb_info: symbol not found` errors that crash the backend on
# boot when prebuilds are used. We build from source instead.
RUN apk add --no-cache git bash docker-cli docker-compose python3 make g++

WORKDIR /app

COPY package*.json ./

# Force native bcrypt to compile against the local musl toolchain.
# The published bcrypt prebuild is glibc-only and crashes with
# `napi_get_cb_info: symbol not found` on alpine, so we replace it with a
# locally-compiled binary using `npm rebuild --build-from-source`.
RUN npm install --production && \
    npm rebuild bcrypt --build-from-source && \
    npm cache clean --force

COPY . .

# Make sure the persistent dirs exist as plain dirs (volume mounts will
# overlay them at runtime).
RUN mkdir -p /app/uploads /app/logs /app/sessions /app/state

# Container-level healthcheck. The orchestrator uses /health/ready (deeper)
# but Docker's HEALTHCHECK uses the cheap liveness probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3005)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 3005

CMD ["node", "src/index.js"]
