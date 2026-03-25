FROM node:22-slim AS base

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

RUN mkdir -p data && echo '{}' > data/stub.json

RUN npm run build

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
