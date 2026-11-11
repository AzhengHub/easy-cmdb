#!/usr/bin/env bash
# dc-db installer for Linux + systemd.
#
# Expected bundle layout:
#   install.sh
#   dc-db
#   dist/
#
# Usage:
#   sudo APP_PORT=80 ./install.sh
#   sudo APP_PORT=80 UPDATE_LISTEN=1 ./install.sh
#
# The installer is idempotent. Existing /opt/dc-db/config.yaml and
# /opt/dc-db/data/dc-db.db are preserved unless UPDATE_LISTEN=1 changes the
# listen line.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dc-db}"
APP_USER="${APP_USER:-dc-db}"
APP_PORT="${APP_PORT:-80}"
SERVICE_NAME="dc-db.service"
BUNDLE_DIR="${BUNDLE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
COOKIE_SECURE="${COOKIE_SECURE:-false}"
OPEN_FIREWALL="${OPEN_FIREWALL:-0}"
UPDATE_LISTEN="${UPDATE_LISTEN:-0}"

fail() {
  echo "install: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请使用 root 运行"
[ -f "$BUNDLE_DIR/dc-db" ] || fail "缺少二进制文件: $BUNDLE_DIR/dc-db"
[ -f "$BUNDLE_DIR/dist/index.html" ] || fail "缺少前端目录: $BUNDLE_DIR/dist"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] || fail "APP_PORT 无效"
[ "$APP_DIR" != "/" ] || fail "APP_DIR 不能是 /"

if ! id "$APP_USER" >/dev/null 2>&1; then
  NOLOGIN=$(command -v nologin || echo /sbin/nologin)
  useradd --system --home-dir "$APP_DIR" --shell "$NOLOGIN" "$APP_USER"
fi

install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/bin" "$APP_DIR/web"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$APP_DIR/data"

install -m 0755 "$BUNDLE_DIR/dc-db" "$APP_DIR/bin/dc-db"
rm -rf "$APP_DIR/web/dist"
cp -a "$BUNDLE_DIR/dist" "$APP_DIR/web/dist"
chown -R root:root "$APP_DIR/bin" "$APP_DIR/web"
chmod -R a+rX "$APP_DIR/bin" "$APP_DIR/web"

FIRST_INSTALL=0
if [ ! -f "$APP_DIR/config.yaml" ]; then
  FIRST_INSTALL=1
  if [ -z "$ADMIN_PASSWORD" ]; then
    command -v openssl >/dev/null 2>&1 || fail "缺少 openssl，请通过 ADMIN_PASSWORD 指定管理员密码"
    ADMIN_PASSWORD=$(openssl rand -hex 16)
  fi
  [ "${#ADMIN_PASSWORD}" -ge 12 ] || fail "管理员密码至少 12 个字符"

  cat > "$APP_DIR/config.yaml" <<EOF
# dc-db deployment configuration
listen: 0.0.0.0:${APP_PORT}
database: ${APP_DIR}/data/dc-db.db
web_dir: ${APP_DIR}/web/dist
cookie_secure: ${COOKIE_SECURE}

admin:
  username: "${ADMIN_USERNAME}"
  password: "${ADMIN_PASSWORD}"

operator:
  username: ""
  password: ""

viewer:
  username: ""
  password: ""
EOF
  chmod 0600 "$APP_DIR/config.yaml"
  chown "$APP_USER:$APP_USER" "$APP_DIR/config.yaml"
  echo "installed new config.yaml"
else
  echo "kept existing config.yaml"
  if [ "$UPDATE_LISTEN" = "1" ]; then
    sed -i -E "s|^listen:.*|listen: 0.0.0.0:${APP_PORT}|" "$APP_DIR/config.yaml"
    chown "$APP_USER:$APP_USER" "$APP_DIR/config.yaml"
    chmod 0600 "$APP_DIR/config.yaml"
    echo "updated listen to 0.0.0.0:${APP_PORT}"
  fi
fi

cat > "/etc/systemd/system/$SERVICE_NAME" <<UNIT
[Unit]
Description=dc-db
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/bin/dc-db serve
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
sleep 2

if command -v curl >/dev/null 2>&1; then
  HEALTH=$(curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/healthz" || true)
elif command -v wget >/dev/null 2>&1; then
  HEALTH=$(wget -qO- --timeout=5 "http://127.0.0.1:${APP_PORT}/healthz" || true)
else
  HEALTH='{"status":"unknown"}'
fi

if ! printf '%s' "$HEALTH" | grep -q '"status":"ok"'; then
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
  fail "服务启动失败或健康检查未通过"
fi

if [ "$OPEN_FIREWALL" = "1" ] && command -v firewall-cmd >/dev/null 2>&1; then
  if firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${APP_PORT}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
    echo "opened firewall port ${APP_PORT}/tcp"
  fi
fi

HOST_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
if [ -z "$HOST_IP" ] && command -v hostname >/dev/null 2>&1; then
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
[ -n "$HOST_IP" ] || HOST_IP="<server-ip>"
if [ "$APP_PORT" = "80" ]; then
  APP_URL="http://${HOST_IP}"
else
  APP_URL="http://${HOST_IP}:${APP_PORT}"
fi

echo
echo "dc-db installed"
echo "  URL:     ${APP_URL}"
echo "  Service: $SERVICE_NAME"
echo "  Data:    $APP_DIR/data/dc-db.db"
if [ "$FIRST_INSTALL" = "1" ]; then
  echo "  Admin:   $ADMIN_USERNAME"
  echo "  Password: $ADMIN_PASSWORD"
  echo "  Save this password now; it is only printed on first install."
fi
