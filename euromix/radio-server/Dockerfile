FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY auth.js media.js server.js ./
USER node

EXPOSE 8787
CMD ["node", "server.js"]
