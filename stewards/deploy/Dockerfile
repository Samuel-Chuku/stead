# Keeper and steward bots. Build context: the repo root (needs fork/addresses.sh for the public
# Aave address book). Secrets are mounted at run time, never baked in.
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
WORKDIR /app/stewards
COPY stewards/package.json stewards/package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY fork/addresses.sh fork/addresses-ethereum.sh /app/fork/
COPY stewards/tsconfig.json ./
COPY stewards/src ./src
COPY stewards/scripts/keeper.ts stewards/scripts/steward.ts stewards/scripts/live-feed.ts stewards/scripts/demo-runner.ts stewards/scripts/demo-keys.ts stewards/scripts/mainnet-panel.ts ./scripts/
RUN mkdir -p /app/stewards/logs && chown node:node /app/stewards/logs
USER node
ENTRYPOINT ["/app/stewards/node_modules/.bin/tsx"]
