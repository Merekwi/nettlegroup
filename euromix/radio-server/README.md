# Euromix Radio Server

This directory contains the deployment foundation for Euromix's own 24/7 radio station.

## Architecture

- **AzuraCast** runs on a VPS controlled by NettleGroup. It provides the AutoDJ, media library, playlist scheduler, Liquidsoap playout and Icecast streaming.
- **One station, one live stream** is the source of truth. Android and the website are listeners; they do not choose tracks or generate separate broadcasts.
- **Station media lives on the VPS disk**, not in Neon Object Storage. Neon remains the application database and identity source.
- **Now-playing metadata** is read from the station's public AzuraCast API and shown by clients.
- **NettleGroup Verify remains the identity provider.** The AzuraCast master API key must never be embedded in the Android APK or a browser page. A server-side control API will be the only component allowed to use it.

AzuraCast is the radio engine, not the public Euromix brand. The long-term control surface remains Euromix. The engine can be replaced later without changing the app's single-stream model.

- **Radio control API**: a small Node service that reads public now-playing data and proxies media/playlist management to AzuraCast without exposing its API key. For every admin request it verifies the existing Euromix HMAC bearer token and re-reads `user_profiles.is_admin` from the shared Neon database.

## What's in this folder

- `install-azuracast.sh`: official installer bootstrap for a fresh Linux VPS.
- `DEPLOY.md`: initial server and station setup checklist.
- `.env.example`: names and examples for values that will be needed when the server is provisioned. It contains no secrets.
- `server.js` / `auth.js`: the private radio-control API and shared-token verifier. The upload API validates relative paths and file types and does not expose AzuraCast's Flow.js upload endpoint.
- `docker-compose.yml` / `Dockerfile`: container definition for the control API.
- `auth.test.js`: automated checks for token verification.

## Server sizing

AzuraCast's published minimum is 2 GB RAM and 20 GB disk on 64-bit x86 or ARM64. Its recommended baseline is 4 CPU cores, 4 GB RAM and 40 GB disk. Those figures are for running the radio software, not for an unlimited music archive. Choose disk size based on the actual library and leave room for backups and upgrades.

At 128 kbit/s, one listener connected continuously for 30 days consumes about 41.5 GB of outgoing traffic. One hundred continuous listeners would be about 4.15 TB/month before protocol overhead. Check the provider's included traffic and overage prices before selecting a VPS.

## Important boundaries

- No VPS has been purchased or created by this repository change.
- The stream URL stays unset in Android until the station has actually been installed, configured and tested.
- The existing Kotlin `RotationPolicy` is a specification/prototype, not a server-side playout worker. It does not currently control the live stream.
- AzuraCast supports general rotation, scheduled playlists and playlists that run every N songs or minutes. Exact artist/genre cooldown scoring and the full custom jingle policy in `../radio-engine/ROTATION.md` still need a Euromix-specific server-side layer and validation on a running station.
- Radio licensing and royalty obligations depend on where Euromix operates and where listeners are located. The operator must secure the required rights before streaming copyrighted music. AzuraCast does not provide music rights.

Admin API routes are restricted to the configured station's `files` and `playlists` resources. No arbitrary AzuraCast URL can be proxied, and the API key is never returned to the client. The adapter listens on localhost port 8787 by default; it must be placed behind an HTTPS reverse proxy before remote app clients can use it.

See [DEPLOY.md](./DEPLOY.md) before bringing up the server.
