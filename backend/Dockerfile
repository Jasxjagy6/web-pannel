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
RUN apk add --no-cache git bash docker-cli docker-compose

WORKDIR /app

COPY package*.json ./

RUN npm install --production && npm cache clean --force

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
