set -eu

cleanup() {
  docker compose down --remove-orphans
}

trap cleanup EXIT INT TERM
docker compose --profile verify run --rm --no-deps --build pr-check
docker compose up --build --wait
docker compose --profile verify run --rm --build migration-smoke
docker compose --profile verify run --rm --build network-off
