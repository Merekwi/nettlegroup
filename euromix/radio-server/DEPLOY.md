# Euromix radio server: deployment checklist

This is the deployment runbook for the first self-hosted station. It deliberately stops before purchasing or provisioning a VPS.

## 1. Prepare the host

Use a fresh 64-bit Linux VPS that can run Docker. AzuraCast currently documents a minimum of 2 GB RAM and 20 GB disk; the recommended baseline is 4 CPU cores, 4 GB RAM and at least 40 GB disk. For a growing music collection, select a larger disk or attach a dedicated data volume.

Before ordering, compare:
- monthly server price including VAT;
- included outbound traffic and the cost of extra traffic;
- disk type and size;
- whether Docker is supported (avoid restricted LXC/OpenVZ containers);
- snapshot/backup price.

Create two DNS A records pointing to the VPS IPv4 address: one for the public stream (for example `radio.example.com`) and one for the control API (for example `radio-control.example.com`). Add AAAA records only when IPv6 is actually configured. Do not copy these example domains literally. Both hostnames must resolve publicly before Caddy can obtain TLS certificates.

Open TCP ports 80 and 443 for Caddy, the configured stream ports required by AzuraCast, and SSH. Keep SSH restricted to the administrator's IP where practical. Do not proxy the public audio stream through an unconfigured CDN.

## 2. Install AzuraCast

Connect over SSH as a sudo-capable administrator. On a fresh Ubuntu/Debian host, run:

```bash
git clone https://github.com/Merekwi/nettlegroup.git
cd nettlegroup/euromix/radio-server
sudo bash install-azuracast.sh
```

The script downloads and runs the official AzuraCast Docker utility installer. Review the installer prompts. It is not a VPS purchase script and it does not change DNS or billing settings.

After installation, change AzuraCast's web ports so Caddy can own public 80/443:

```bash
cd /var/azuracast
sudo ./docker.sh change-ports
```

Set HTTP to `8080` and HTTPS to `8443`. Then restart the AzuraCast stack from `/var/azuracast` using `sudo docker-compose down` followed by `sudo docker-compose up -d`. Caddy will reverse-proxy the stream hostname to HTTP port 8080 and the control hostname to the private API on port 8787. Complete the initial AzuraCast setup at the stream hostname. Create a unique administrator password and store it in a password manager. Before enabling uploads, confirm the installed AzuraCast version is **0.23.6 or newer**. Versions through 0.23.5 are affected by CVE-2026-42605 in the Flow.js upload endpoint; the control API deliberately does not expose that endpoint.

Official installation instructions: https://www.azuracast.com/docs/getting-started/installation/docker/

## 3. Create the Euromix station

In AzuraCast:
1. Create one station named **Euromix Radio**.
2. Set its shortcode to **euromix**. Keep this value stable because client URLs and metadata use it.
3. Set the station timezone to **Europe/Berlin** unless the station operator explicitly chooses another timezone.
4. Configure one public MP3 mount point, initially 128 kbit/s. This is a practical starting point, not a fixed limit.
5. Enable AutoDJ and verify the station is broadcasting continuously even when there are zero listeners.

Use the actual stream URL displayed by AzuraCast after the mount is created. The common path shape is `https://radio.example.com/listen/euromix/radio.mp3`, but the authoritative URL is the one shown by the station's own administration page. Do not put an invented URL into the Android app.

The public now-playing endpoint should be available at:

```
https://radio.example.com/api/nowplaying/euromix
```

Verify it returns the station and current-track data before integrating it into Android.

## 4. Build the media library

Upload files through the AzuraCast Media Manager or its Docker SFTP service. Do not send audio files through Neon or GitHub.

Create these initial playlists:
- **Основная ротация**: the regular music pool, shuffled.
- **Новинки**: new and priority tracks, included in normal rotation with a controlled weight.
- **Джинглы**: station IDs and short audio branding.
- **Ночные**: softer tracks for the night daypart.
- **Эфиры и спецвыпуски**: reserved for explicitly scheduled content.

Important: an uploaded file must be assigned to at least one playlist to be played by AutoDJ. Use folders and folder-to-playlist assignment so future uploads are categorized automatically.

## 5. Initial rotation rules

Configure the first station using native playlist rules:
- music playlists: general rotation, shuffled playback;
- scheduled programming: schedule by weekday and local time;
- jingles: start with an interval playlist, for example every 4 songs, and/or a time interval;
- keep a separate emergency/fallback music playlist so the station never runs out of eligible media.

AzuraCast documents general rotation, once-per-X-songs/minutes and scheduled playlists. Do not assume its default playlist counter exactly matches the custom Euromix rule: validate whether jingles increment the song counter on the installed version. If that changes the intended spacing, implement the custom Liquidsoap logic before opening the station to listeners.

The richer rotation policy in [ROTATION.md](../radio-engine/ROTATION.md) remains the target: track cooldowns, artist/genre cooldowns, weighted selection, dayparts and jingle precedence. Native AutoDJ settings are the first live baseline, not a claim that every custom rule is already implemented.

## 6. Deploy the private Euromix control API

The control service runs separately from AzuraCast and connects to the same Neon user table. It listens only on `127.0.0.1:8787` on the host; do not expose that port directly to the internet.

After the station exists, copy the folder to the VPS (or pull the repository) and create a private `.env` file:

```bash
cd nettlegroup/euromix/radio-server
cp .env.example .env
nano .env
```

Set real `RADIO_DOMAIN` and `RADIO_CONTROL_DOMAIN` values first, then set the pooled Neon `DATABASE_URL`, the existing NettleGroup `SESSION_SECRET`, the AzuraCast API base ending in `/api`, the station's numeric ID, and the AzuraCast API key. Set `EUROMIX_ALLOWED_ORIGIN` to the exact web origin used by the Euromix site. Do not commit `.env`.

Start and check the service:

```bash
docker compose up --build -d
docker compose logs --tail=100 euromix-radio-control
curl -fsS http://127.0.0.1:8787/health
```

The health endpoint must return `{\"ok\":true,...}`. The bundled Caddy service owns public ports 80/443 and obtains TLS certificates automatically once both DNS records point to the host. It routes the stream domain to AzuraCast on port 8080 and the control domain to `127.0.0.1:8787`. Keep AzuraCast's HTTPS backend port 8443 private and unused by the public clients.

The service exposes public `GET /api/now-playing`, authenticated `GET /api/admin/station`, `GET /api/admin/files`, `GET /api/admin/playlists`, and a station-scoped file/playlist metadata proxy. Media upload uses a separate `POST /api/admin/upload` JSON endpoint that accepts a safe relative media path and base64 file data; it rejects path traversal, unsupported extensions and files larger than 18 MiB by default. This fits AzuraCast's documented default 25M PHP request limit and 50M NGINX request-body limit after base64 encoding. Larger individual files require raising the corresponding AzuraCast limits in `azuracast.env` and `.env`, then restarting the AzuraCast Docker Compose stack. It calls AzuraCast's JSON `POST /api/station/{station_id}/files` endpoint, not the vulnerable Flow.js `/files/upload` endpoint. Admin access is checked against the existing `user_profiles.is_admin` field on every request.

## 7. API key and app integration

After the station is running:
1. Create a restricted station-management user for the radio integration.
2. Create an AzuraCast API key for that user.
3. Keep the key on the server only. Never paste it into `Config.kt`, an APK, a public HTML file, GitHub Actions logs or a client-side JavaScript bundle.
4. Save the API base URL, station ID/shortcode and stream URL in the server's private environment.
5. Connect the Euromix control API to AzuraCast and NettleGroup's existing user database. That API must verify the existing Euromix bearer token and read the user's current `is_admin` value from the shared user profile table before allowing management actions.

The app's current stream URL is intentionally blank. After the DNS names are live, configure it to use the exact stream mount URL shown by AzuraCast (commonly `https://radio.example.com/listen/euromix/radio.mp3`). Set the radio-control base URL to `https://radio-control.example.com` only after `/health` succeeds through Caddy.

To raise the per-file limit later, edit AzuraCast's `azuracast.env` (`PHP_MAX_FILE_SIZE`, `PHP_MEMORY_LIMIT`) and `.env` (`NGINX_CLIENT_MAX_BODY_SIZE`) together. Do not raise only the Euromix API limit: the AzuraCast reverse proxy or PHP process may still reject the body. AzuraCast documents restarting after environment edits with `docker-compose down` followed by `docker-compose up -d`; schedule this as a short maintenance window.

## 8. Backups and operations

- Back up station configuration and media to storage outside the VPS. A disk snapshot on the same host is not a complete backup.
- Keep at least one restore test, not just a backup file.
- Monitor disk space, RAM, CPU, station uptime and listener traffic.
- Do not delete the only copy of uploaded media when removing a playlist.
- Test restart/recovery and playback with no listeners connected before public launch.

## Official references

- Requirements: https://www.azuracast.com/docs/getting-started/requirements/
- Docker installation: https://www.azuracast.com/docs/getting-started/installation/docker/
- Media management: https://www.azuracast.com/docs/user-guide/media-management/
- Playlists: https://www.azuracast.com/docs/user-guide/playlists/
- API authentication and capabilities: https://www.azuracast.com/docs/developers/apis/
- Now playing API: https://www.azuracast.com/docs/developers/now-playing-data/
