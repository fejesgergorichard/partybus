# syntax=docker/dockerfile:1.6

# ---------- 1. Build the React client to static files ----------
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- 2. Build the TypeScript server to dist/ ----------
FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/ ./
RUN npm run build

# ---------- 3. Lean runtime image ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV STATIC_DIR=/app/client-dist

# Install production deps only.
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# Copy compiled server + client bundle.
COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist ./client-dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
