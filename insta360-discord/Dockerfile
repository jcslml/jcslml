FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080 1935
CMD ["node", "src/server.js"]
