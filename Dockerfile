# ── build stage (has the toolchain to compile better-sqlite3) ────────────────
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime stage (slim; reuses the compiled native modules) ─────────────────
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
