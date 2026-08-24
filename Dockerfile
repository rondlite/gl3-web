# Build the site and compile the server, then ship only what is needed to run.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server ./server
COPY site ./site
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/site/.vitepress/dist ./site/.vitepress/dist

USER node

EXPOSE 8080
CMD ["node", "dist/server/index.js"]
