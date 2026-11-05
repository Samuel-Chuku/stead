# Running the keeper and stewards as services (systemd)

Each process restarts on crash (`Restart=always`, 5 s back-off, no start limit) and appends to its own log in `/var/log/stead/`.

## Install (on the VPS, as root)
```sh
useradd --system --create-home --home-dir /home/stead stead
git clone <repo> /opt/stead && cd /opt/stead/stewards && npm ci --ignore-scripts
install -d -o stead -g stead /var/log/stead /opt/stead/stewards/logs
# secrets: /opt/stead/.env (EVM keys, optional SEPOLIA_RPC_URL / NEAR_AI_API_KEY) and the NEAR
# keys in /home/stead/.near-credentials/testnet/, both owned by stead, mode 600
cp deploy/stead-keeper.service deploy/stead-steward@.service /etc/systemd/system/
cp deploy/stead.logrotate /etc/logrotate.d/stead
systemctl daemon-reload
systemctl enable --now stead-keeper stead-steward@patient stead-steward@swift stead-steward@deep stead-steward@pool
```

## Operate
```sh
systemctl status 'stead-*'
tail -f /var/log/stead/keeper.log /var/log/stead/steward-*.log
systemctl restart stead-steward@deep
```

Set `STEAD_EVM=fork` in the unit files to run against a local fork instead of Sepolia. Every log line carries the trust label of the mode it runs in.
