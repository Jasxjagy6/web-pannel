# Stage 1: Build the React app with Vite
FROM node:18-alpine AS build

# Build args passed by the orchestrator (`bin/upgrade deploy`). Declared
# here so docker doesn't warn "ARG was not consumed". The SPA itself
# doesn't need them at runtime, but we surface them in the image meta so
# `docker inspect web-pannel-frontend:<tag>` reveals which commit is on
# disk — useful for blue/green debugging.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV VITE_GIT_SHA=${GIT_SHA}
ENV VITE_BUILD_TIME=${BUILD_TIME}

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

# Stage 2: Serve with nginx
#
# In the dockerized deploy, the frontend container serves the SPA only.
# Caddy is the public-facing reverse proxy and handles /api/* and
# /socket.io/* routing to the active backend color (blue/green). For
# direct-access debugging the operator can `docker compose port frontend 83`
# but API calls won't resolve from there — use the Caddy port (80/443) for
# end-to-end testing.
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

RUN rm /etc/nginx/conf.d/default.conf

COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 83;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback. Caddy handles /api and /socket.io.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # If someone hits this container directly with /api or /socket.io
    # (i.e. bypassing Caddy), return a clear 502 instead of a confusing
    # 404. Operators should always use the Caddy port.
    location /api {
        return 502 'frontend container does not proxy /api; use Caddy on :80/:443';
    }
    location /socket.io {
        return 502 'frontend container does not proxy /socket.io; use Caddy on :80/:443';
    }
}
EOF

EXPOSE 83

CMD ["nginx", "-g", "daemon off;"]
