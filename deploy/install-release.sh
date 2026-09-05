#!/usr/bin/env bash
set -euo pipefail
# Run only from a release produced from a verified, already-pushed Git commit.
release_path="$(pwd)"
root=/opt/apps/unfortunately
test -f "$release_path/package-lock.json"
test -f "$root/shared/runtime.env"
test -d "$root/shared/data"
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
npm ci --no-audit --no-fund
npm run check
npm prune --omit=dev --no-audit --no-fund
backup_path="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_path"
chmod 700 "$backup_path"
# Preserve configuration before any publication change.
sudo tar -czf "$backup_path/nginx-before.tar.gz" -C /etc nginx
sudo chmod 600 "$backup_path/nginx-before.tar.gz"
if test -L "$root/current"; then
    readlink "$root/current" > "$backup_path/previous-release.txt"
    if test -f "$root/shared/data/unfortunately.sqlite"; then
        (cd "$root/current" && node deploy/backup.mjs)
    fi
fi
cp "$root/shared/runtime.env" "$backup_path/runtime-before.env"
chmod 600 "$backup_path/runtime-before.env"
node deploy/set-revision.mjs
ln -s "$release_path" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
sudo install -m 644 deploy/unfortunately.service /etc/systemd/system/unfortunately.service
sudo install -m 644 deploy/unfortunately-backup.service /etc/systemd/system/unfortunately-backup.service
sudo install -m 644 deploy/unfortunately-backup.timer /etc/systemd/system/unfortunately-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable unfortunately.service unfortunately-backup.timer
sudo systemctl restart unfortunately.service
sudo systemctl start unfortunately-backup.timer
for i in {1..20}; do
    if curl -fsS http://127.0.0.1:3210/api/health; then break; fi
    sleep 1
done
curl -fsS http://127.0.0.1:3210/api/health
if ! sudo test -f /etc/letsencrypt/live/unfortunately.dkz12345.com/fullchain.pem; then
    sudo install -m 644 deploy/nginx-http.conf /etc/nginx/sites-available/unfortunately.dkz12345.com
    sudo ln -sfn /etc/nginx/sites-available/unfortunately.dkz12345.com /etc/nginx/sites-enabled/unfortunately.dkz12345.com
    sudo nginx -t
    sudo systemctl reload nginx
    sudo certbot certonly --webroot -w /var/www/html -d unfortunately.dkz12345.com --non-interactive
fi
sudo install -m 644 deploy/nginx.conf /etc/nginx/sites-available/unfortunately.dkz12345.com
sudo ln -sfn /etc/nginx/sites-available/unfortunately.dkz12345.com /etc/nginx/sites-enabled/unfortunately.dkz12345.com
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl start unfortunately-backup.service
curl -fsS https://unfortunately.dkz12345.com/api/health
