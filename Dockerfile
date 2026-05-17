FROM node:18-alpine

# Docker CLI para soporte de docker compose
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

# Nota: se ejecuta como root para poder acceder al socket Docker del host.
# El socket se monta en tiempo de ejecución: -v /var/run/docker.sock:/var/run/docker.sock
CMD ["node", "src/mcp-server.js"]
