# AFWC Board — single self-contained Node.js app + SQLite.
# No build step, no native frontend toolchain: better-sqlite3 is the only
# compiled dependency and ships prebuilt binaries for node:22-slim's platform.
FROM node:22-slim

WORKDIR /app

# Install dependencies first so `npm ci` is cached across code-only rebuilds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
