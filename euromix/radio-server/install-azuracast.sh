#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${AZURACAST_INSTALL_DIR:-/var/azuracast}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root, for example: sudo bash install-azuracast.sh" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify the operating system. Use a fresh Linux VPS supported by AzuraCast." >&2
  exit 1
fi

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *)
    echo "This bootstrap is intended for Ubuntu/Debian. Check AzuraCast's current OS support before continuing." >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl git
fi

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [[ -e docker.sh ]]; then
  cp docker.sh "docker.sh.backup.$(date -u +%Y%m%dT%H%M%SZ)"
fi

curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/AzuraCast/AzuraCast/main/docker.sh \
  --output docker.sh
chmod 0755 docker.sh

echo
echo "Starting the official AzuraCast installer in: $INSTALL_DIR"
echo "Review its prompts. This script does not purchase a server or configure DNS."
echo

exec ./docker.sh install
