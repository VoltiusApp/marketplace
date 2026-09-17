#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name=voltius-s3-sync-minio
port=19000
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:$port:9000" \
  -e MINIO_ROOT_USER=voltiustest -e MINIO_ROOT_PASSWORD=voltiustest-secret \
  quay.io/minio/minio:latest server /data >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/minio/health/live" >/dev/null 2>&1 && break
  sleep 1
done
MINIO_ENDPOINT="http://127.0.0.1:$port" MINIO_USER=voltiustest MINIO_PASSWORD=voltiustest-secret \
  npx vitest run test/minio.test.ts
