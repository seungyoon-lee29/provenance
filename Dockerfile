FROM node:22-alpine

# postgresql17-client: pg_dump/psql for the SEC-09 backup/restore drill (matches the postgres:17 server).
# ponytail: added to the shared image; split into a drill-only stage if a hardened prod image ever ships.
RUN apk add --no-cache postgresql17-client

WORKDIR /app

COPY package.json package-lock.json ./
# vendor/ holds the `file:` no-op stand-in for the `server-only` marker; npm ci resolves it
# from disk, so it must land before install. See vendor/server-only/index.js.
COPY vendor ./vendor
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000 3001
CMD ["npm", "start", "--", "--hostname", "0.0.0.0"]
