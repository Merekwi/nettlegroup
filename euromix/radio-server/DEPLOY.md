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

Create an A record for a dedicated hostname, for example `radio.your-domain.example`, pointing to the VPS IPv4 address. Add an AAAA record only when IPv6 is actually configured on the host. Do not copy the example hostname literally.

Open the ports required by the AzuraCast installer and the configured public stream. Keep SSH restricted to the administrator's IP where practical. Do not put an unconfigured Cloudflare proxy in front of the audio stream.

## 2. Install AzuraCast

Connect over SSH as a sudo-capable administrator. On a fresh Ubuntu/Debian host, run:

```bash
git clone https://github.com/Merekwi/nettlegroup.git
cd nettlegroup/euromix/radio-server
sudo bash install-azuracast.sh
```

The script downloads and runs the official AzuraCast Docker utility installer. Review the installer prompts. It is not a VPS purchase script and it does not change DNS or billing settings.

After installation, open the hostname in a browser and complete the initial AzuraCast setup. Create a unique administrator password and store it in a password manager.

Official installation instructions: https://www.azuracast.com/docs/getting-started/installation/docker/

## 3. Create the Euromix station

In AzuraCast:
1. Create one station named **Euromix Radio**.
2. Set its shortcode to **euromix**. Keep this value stable because client URLs and metadata use it.
3. Set the station timezone to **Europe/Berlin** unless the station operator explicitly chooses another timezone.
4. Configure one public MP3 mount point, initially 128 kbit/s. This is a practical starting point, not a fixed limit.
5. Enable AutoDJ and verify the station is broadcasting continuously even when there are zero listeners.

Use the actual stream URL displayed by AzuraCast after the mount is created. The common path shape is `https://radio.your-domain.example/listen/euromix/radio.mp3`, but the authoritative URL is the one shown by the station's own administration page. Do not put an invented URL into the Android app.

The public now-playing endpoint should be available at:

```
https://radio.your-domain.example/api/nowplaying/euromix
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

## 6. API key and app integration

After the station is running:
1. Create a restricted station-management user for the radio integration.
2. Create an AzuraCast API key for that user.
3. Keep the key on the server only. Never paste it into `Config.kt`, an APK, a public HTML file, GitHub Actions logs or a client-side JavaScript bundle.
4. Save the API base URL, station ID/shortcode and stream URL in the server's private environment.
5. Connect the Euromix control API to AzuraCast and NettleGroup's existing user database. That API must verify the existing Euromix bearer token and read the user's current `is_admin` value from the shared user profile table before allowing management actions.

The app's current stream URL is intentionally blank. It should be changed only after the actual mount URL has been copied from the installed station and tested from an external network.

## 7. Backups and operations

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
