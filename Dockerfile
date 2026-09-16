FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install production dependencies only (cached layer).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public
COPY data ./data

# The bundled "node" user (uid 1000) runs the app and may write data/state.json.
RUN chown -R node:node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1

CMD ["node", "server.js"]
