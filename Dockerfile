# ── build stage ──────────────────────────────────────────────────────────────
FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime stage (slim; reuses the installed modules) ───────────────────────
# Stateless: the queue lives in Postgres and screenshots in Garage, so the
# container can run on whichever node is active.
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8090
CMD ["node", "dist/index.js"]
