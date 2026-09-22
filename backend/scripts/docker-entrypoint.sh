#!/bin/sh
set -e

APP_UID=1001
APP_GID=1001

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

# ── Storage local: o diretório precisa ser gravável PELO usuário do Node ──────
# Com STORAGE_DRIVER=local os arquivos vão para LOCAL_STORAGE_DIR (relativo a
# /app). Em produção esse caminho é um volume montado: o ponto de montagem nasce
# de root, e o processo Node roda sem privilégio — sem o chown abaixo, todo
# upload falha com EACCES.
uploads_dir="${LOCAL_STORAGE_DIR:-uploads}"
case "$uploads_dir" in
  /*) ;;
   *) uploads_dir="/app/$uploads_dir" ;;
esac

mkdir -p "$uploads_dir" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  chown -R "$APP_UID:$APP_GID" "$uploads_dir" || true
fi

# Sonda de escrita como o usuário que de fato vai gravar. Um diretório de
# uploads não-gravável é justamente a falha que passa despercebida: a API sobe,
# responde, e só o upload quebra. Melhor gritar no boot.
probe="$uploads_dir/.write-probe"
if [ "$(id -u)" = "0" ]; then
  writable=$(setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
    sh -c "touch '$probe' 2>/dev/null && rm -f '$probe' && echo sim" || true)
else
  writable=$(touch "$probe" 2>/dev/null && rm -f "$probe" && echo sim || true)
fi

if [ "$writable" = "sim" ]; then
  echo "    uploads=$uploads_dir (gravável)"
else
  echo "AVISO: $uploads_dir NÃO é gravável — uploads de foto/documento vão falhar."
  echo "       Com STORAGE_DRIVER=local, monte um volume nesse caminho."
fi

if [ "${STORAGE_DRIVER:-local}" = "local" ]; then
  echo "    STORAGE_DRIVER=local — arquivos só sobrevivem a um deploy se"
  echo "    $uploads_dir for um volume persistente."
fi

# Node nunca roda como root (CIS Docker Benchmark 4.1): uma RCE via dependência
# não ganha privilégio no container. O root existe apenas até aqui, para ajustar
# a dono do volume; a partir do exec o processo é do appuser.
if [ "$(id -u)" = "0" ]; then
  if command -v setpriv >/dev/null 2>&1; then
    # setpriv troca de usuário no mesmo processo: o Node continua sendo o PID 1
    # e recebe SIGTERM do orquestrador direto, sem intermediário.
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups node dist/server.js
  fi
  # Rede de segurança caso a imagem base perca o util-linux. O `su` interpõe um
  # processo entre o PID 1 e o Node (shutdown menos limpo), mas é preferível a
  # rodar como root.
  echo "AVISO: setpriv ausente — caindo para 'su'. Reinstale util-linux na imagem."
  exec su appuser -s /bin/sh -c 'exec node dist/server.js'
fi

exec node dist/server.js
