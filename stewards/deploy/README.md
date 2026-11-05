# Running the keeper and stewards as services

Each process (the keeper and the four stewards) runs in its own container, restarts on crash and keeps rotated logs. Two ways to run them; the containers are the default.

## Docker (default)
```sh
# on the host, as root
install -d -m 755 -o 1000 -g 1000 /opt/stead/logs
install -d -m 700 -o 1000 -g 1000 /opt/stead/secrets /opt/stead/secrets/near
# /opt/stead/secrets/.env: steward EVM keys, NEAR_RPC_URL, optional SEPOLIA_RPC_URL / NEAR_AI_API_KEY
# /opt/stead/secrets/near/: NEAR keys of the reporter and the stewards (the contract owner's key stays offline)
chmod 600 /opt/stead/secrets/.env /opt/stead/secrets/near/*.json

cd stewards/deploy && docker compose up -d --build
```
- `restart: always`; logs via `docker compose logs -f`, rotated at 10 MB × 5 per process; AI adjustment records in `/opt/stead/logs`.
- `STEAD_EVM=sepolia`: Aave readings come from verified OutLayer proofs; the keeper's NEAR account must be allowed to use the proof program's OutLayer secret.
- Polling: keeper every 6 s, stewards every 5 s; a verified reading every 30 s while a rescue is live, every minute near the trigger, every 30 min otherwise (an unverified RPC read only decides when to pay for a proof).

## systemd (alternative, Node on the host)
```sh
useradd --system --create-home --home-dir /home/stead stead
git clone <repo> /opt/stead && cd /opt/stead/stewards && npm ci --ignore-scripts
install -d -o stead -g stead /var/log/stead /opt/stead/stewards/logs
cp deploy/stead-keeper.service deploy/stead-steward@.service /etc/systemd/system/
cp deploy/stead.logrotate /etc/logrotate.d/stead
systemctl daemon-reload
systemctl enable --now stead-keeper stead-steward@patient stead-steward@swift stead-steward@deep stead-steward@pool
```

Every log line carries the trust label of the mode it runs in.
