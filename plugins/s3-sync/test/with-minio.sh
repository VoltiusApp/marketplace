#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name=voltius-s3-sync-minio
port=19000
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --name "$name" -p "127.0.0.1:$port:9000" \
  -e MINIO_ROOT_USER=voltiustest -e MINIO_ROOT_PASSWORD=voltiustest-secret \
  quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/minio/health/live" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/minio/health/live" >/dev/null 2>&1 || { echo "MinIO did not become healthy"; exit 1; }
MINIO_ENDPOINT="http://127.0.0.1:$port" MINIO_USER=voltiustest MINIO_PASSWORD=voltiustest-secret \
  npx vitest run test/minio.test.ts
