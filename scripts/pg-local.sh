#!/usr/bin/env bash
# Local PostgreSQL for development and tests.
#
# docker-compose.yml is the intended path; this script exists for environments
# where the container registry is unreachable but the server binaries are
# installed. Both produce the same database on port 5433.
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/var/lib/postgresql/coordinator}
PORT=${PGPORT:-5433}

case "${1:-start}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$PGDATA"
      chown -R postgres "$PGDATA"
      su postgres -c "PATH=$PGBIN:\$PATH initdb -U coordinator --auth=trust -D $PGDATA" >/dev/null
    fi
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA \
      -o '-p $PORT -c listen_addresses=127.0.0.1' -l $PGDATA/pg.log start"
    until psql "postgres://coordinator@127.0.0.1:$PORT/postgres" -c 'SELECT 1' >/dev/null 2>&1; do
      sleep 1
    done
    psql "postgres://coordinator@127.0.0.1:$PORT/postgres" \
      -tAc "SELECT 1 FROM pg_database WHERE datname='coordinator'" | grep -q 1 ||
      psql "postgres://coordinator@127.0.0.1:$PORT/postgres" -c 'CREATE DATABASE coordinator'
    echo "postgres ready on $PORT"
    ;;
  stop)
    su postgres -c "PATH=$PGBIN:\$PATH pg_ctl -D $PGDATA stop" || true
    ;;
  *)
    echo "usage: $0 {start|stop}" >&2
    exit 2
    ;;
esac
