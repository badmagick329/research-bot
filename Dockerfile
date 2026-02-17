FROM oven/bun:1.2.17 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "src/index.ts", "run"]
