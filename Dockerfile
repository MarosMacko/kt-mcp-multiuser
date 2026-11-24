# Build stage — full dev dependencies for the TypeScript compile.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-info.mjs ./scripts/
# The image has no .git, so the commit shown on the pages comes in as a build
# argument (docker-compose.yml passes BUILD_COMMIT through). Empty = unknown.
ARG BUILD_COMMIT=""
RUN BUILD_COMMIT="$BUILD_COMMIT" npm run build && find dist -name '*.test.js*' -delete

# Runtime stage — production dependencies only.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8092 STATE_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Token state lives on a volume so a redeploy doesn't force anyone to
# reconnect their connector.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8092
CMD ["node", "dist/index.js"]
