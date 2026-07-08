#!/bin/sh
set -e

echo "==> AccessHub API — boot"
echo "    NODE_ENV=${NODE_ENV:-unset}"
echo "    PORT=${PORT:-3333}"

missing=""
[ -z "$DATABASE_URL" ] && missing="$missing DATABASE_URL"
[ -z "$JWT_SECRET" ] && missing="$missing JWT_SECRET"
[ -z "$BADGE_HASH_SECRET" ] && missing="$missing BADGE_HASH_SECRET"

if [ -n "$missing" ]; then
  echo "ERRO: variáveis obrigatórias ausentes:$missing"
  echo "Configure-as em Railway → Variables (referencie Postgres para DATABASE_URL)."
  exit 1
fi

exec node dist/server.js
