ARG NODE_IMAGE=novel-codex-node:22
FROM ${NODE_IMAGE}

WORKDIR /app/frontend

COPY frontend/ ./

EXPOSE 5173

CMD ["sh", "-c", "if [ ! -x node_modules/.bin/vite ]; then npm ci --no-audit --prefer-offline; fi; npm run dev:docker"]
