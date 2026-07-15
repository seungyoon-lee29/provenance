set -eu

cleanup() {
  docker compose down --remove-orphans
}

trap cleanup EXIT INT TERM
docker compose --profile verify run --rm --no-deps pr-check
docker compose up --build --wait
docker compose --profile verify run --rm migration-smoke
docker compose --profile verify run --rm network-off
