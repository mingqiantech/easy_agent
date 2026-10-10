FROM oven/bun:1.4

WORKDIR /app

# 先复制依赖清单，利用构建缓存
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY plugins ./plugins

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV PORT=4096
ENV EASY_AGENT_STATE_DIR=/app/data

EXPOSE 4096

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:4096/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "packages/server/src/index.ts"]
