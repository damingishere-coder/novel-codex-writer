ARG NODE_IMAGE=node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
FROM ${NODE_IMAGE}

WORKDIR /app/frontend

RUN mkdir -p /app/frontend/node_modules \
    && chown -R node:node /app

COPY --chown=node:node frontend/ ./

USER node

EXPOSE 5173

CMD ["sh", "-c", "set -eu; LOCK_HASH=$(sha256sum package-lock.json | cut -d' ' -f1); if [ ! -x node_modules/.bin/vite ] || [ \"$(cat node_modules/.package-lock.sha256 2>/dev/null)\" != \"$LOCK_HASH\" ]; then npm ci --no-audit --prefer-offline; printf '%s' \"$LOCK_HASH\" > node_modules/.package-lock.sha256; fi; exec npm run dev:docker"]
