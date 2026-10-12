#!/bin/sh
set -eu
mkdir -p /data/public
if [ ! -f /data/capacity.json ]; then
  cp /app/deploy/docker-capacity.json /data/capacity.json
fi
if [ ! -f /data/public/index.html ]; then
  bun src/cli.ts limits --input /data/capacity.json --sqlite /data/spendwatch.db --html /data/public/index.html
fi
cp -n /app/assets/icons/* /data/public/
exec bun src/cli.ts server --input /data/capacity.json --sqlite /data/spendwatch.db --public-dir /data/public --host 0.0.0.0 --port 8899 --vapid-subject mailto:operator@example.invalid
