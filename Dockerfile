# Blobbi Rumble: the built game and the authoritative match in one Node process
# (`npm run serve`: page and WebSocket on one port, TLS terminated in front).
#
#   docker build -t blobbi-rumble .
#   docker run --rm -p 8080:8080 -e PUBLIC_URL=https://rumble.example blobbi-rumble
#
# Stage 1 builds the page (dist/) and the server bundle (.serve/); stage 2
# runs them with production dependencies only, as an unprivileged user.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npx vite build --ssr src/rumble/net/serve-cli.ts --outDir .serve --emptyOutDir --logLevel warn

FROM node:22-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/.serve ./.serve
# Defaults the process reads (see HOSTING.md): bind to every interface in the container, port 8080.
ENV HOST=0.0.0.0 PORT=8080 STATIC_DIR=/app/dist
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# SIGTERM reaches the process directly (no shell): the server closes its sockets, then exits.
CMD ["node", ".serve/serve-cli.js"]
