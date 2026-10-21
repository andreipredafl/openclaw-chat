# Build stage: all dependencies, TypeScript compiled to dist/.
FROM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and dist/ only, run as the node user.
FROM node:22.23.4-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Mount point for the device identity volume (DEVICE_IDENTITY_PATH in docker-compose.yml).
# Created here so the volume is owned by node, not root.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
