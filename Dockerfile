FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
