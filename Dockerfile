# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS base
WORKDIR /app
# Prisma CLI uses OpenSSL during generation; CA roots are also needed for TLS.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# prebuild generates the Prisma TypeScript client; Nest compiles it into dist.
RUN npm run build

# Explicit operator-only image: migrations are never run by application startup.
FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "db:migrate:deploy"]

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SWAGGER_ENABLED=false \
    DATABASE_ENABLED=false \
    REDIS_ENABLED=false \
    QUEUE_ENABLED=false \
    QWEN_ENABLED=false
COPY package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
