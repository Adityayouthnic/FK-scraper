FROM mcr.microsoft.com/playwright:v1.55.1-jammy

WORKDIR /app

# Install Python3 and pip for the Zepto automation engine
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY zepto_engine/requirements.txt ./zepto_engine/requirements.txt
RUN python3 -m pip install --no-cache-dir -r zepto_engine/requirements.txt

COPY server.js ./
COPY src ./src
COPY public ./public
COPY zepto_engine ./zepto_engine

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
