#!/bin/sh
# Write the Kalshi private key from secret env var to file on volume
if [ -n "$KALSHI_PRIVATE_KEY" ]; then
  echo "$KALSHI_PRIVATE_KEY" > /data/kalshi_private_key.pem
  chmod 600 /data/kalshi_private_key.pem
fi
exec bun run src/index.ts
