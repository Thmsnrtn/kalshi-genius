FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY tsconfig.json ./
COPY src/ ./src/
RUN mkdir -p /data
CMD ["bun", "run", "src/index.ts"]
