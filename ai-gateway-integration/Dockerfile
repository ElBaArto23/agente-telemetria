# Dockerfile para desplegar este backend en Azure Container Apps.
#
# No incluye el .env -- las variables de entorno (APIM_GATEWAY_URL,
# APIM_API_KEY, APPINSIGHTS_APP_ID, APPINSIGHTS_API_KEY,
# FINOPS_LOG_ANALYTICS_WORKSPACE_ID, etc.) se configuran en el propio
# Container App (como "secrets" + "env vars"), no dentro de la imagen --
# nunca subas el .env real en la imagen ni en el repositorio.

FROM node:20-slim

WORKDIR /app

# Se copian primero solo los manifiestos para aprovechar la cache de Docker:
# si no cambian package.json/package-lock.json, no se reinstalan dependencias
# en cada build aunque cambie el codigo.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Container Apps enruta trafico al puerto que declares como "target port" al
# crear/actualizar el recurso -- aqui se usa 3000 para que coincida con el
# default de server.js (const PORT = process.env.PORT || 3000).
EXPOSE 3000

CMD ["node", "server.js"]