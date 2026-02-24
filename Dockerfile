# syntax=docker/dockerfile:1

FROM node:24-alpine

# Instalar dependencias del sistema para mejor estabilidad
RUN apk add --no-cache \
    dumb-init \
    && addgroup -g 1001 -S nodejs \
    && adduser -S wa2dc -u 1001

WORKDIR /usr/local/WA2DC

# Copiar package files y instalar dependencias
COPY package*.json ./
RUN npm ci --omit=dev --only=production && npm cache clean --force

# Copiar código fuente
COPY --chown=wa2dc:nodejs . .

# Cambiar a usuario no-root
USER wa2dc

# Exponer puerto si es necesario (ajustar según admin de sistema)
EXPOSE 8080

# Usar dumb-init para manejo correcto de señales
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]