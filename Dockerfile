FROM oven/bun:1.4.2
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git zsh ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun
EXPOSE 8899
ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
