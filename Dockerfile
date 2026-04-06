FROM oven/bun:1.1-slim
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --production
COPY tsconfig.json ./
COPY src/ ./src/
RUN mkdir -p /data
CMD ["bun", "run", "src/index.ts"]
