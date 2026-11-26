# Euromix radio rotation

The playout service is the single source of truth. Android clients never choose tracks or jingles locally: every listener receives the same continuous stream and the same "now playing" metadata.

## Music selection

1. Build the eligible pool from enabled tracks only. Skip missing files, tracks outside their allowed daypart, and tracks inside the 36-track recent-play cooldown.
2. Score each remaining track:
   - base weight 100;
   - admin priority adds 8 points per level;
   - artist heard in the previous 4 songs: multiply by 0.12;
   - genre heard in the previous 2 songs: multiply by 0.72;
   - outside preferred daypart: multiply by 0.35;
   - frequent-play penalty: divide by (1 + play_count * 0.025);
   - long-since-played boost: gradually increase up to 3x.
3. Pick by weighted random, not simple shuffle. This keeps the station varied while respecting editorial priorities.
4. If the strict cooldown empties the pool, relax to 8 recent tracks, then use the full enabled pool as a last resort. Never leave the stream silent because the library is small.
5. Update play counts, recent track/artist/genre history and the global now-playing record only after the stream actually starts the item.

## Jingles and station IDs

- Random station ID after a randomized 3-5 songs, selected when the admin enables that rule.
- Enforce at least 8 minutes between non-emergency jingles.
- Scheduled IDs are keyed by local station date + jingle ID and can fire only once per day, even if several songs play during the same hour.
- Track-specific intro IDs play immediately before their configured track.
- Admin can enable/disable each rule and set a station timezone. Default timezone: Europe/Moscow.
- A scheduled ID takes priority over a random interval ID. A track-specific intro takes priority over the random interval ID.

## Dayparts and editorial balance

Suggested defaults (all editable by station admin):
- 06:00-11:00: upbeat pop, light rotation.
- 11:00-17:00: broad hit rotation, new releases and recurrent tracks.
- 17:00-22:00: high-energy and chart tracks.
- 22:00-06:00: softer pop and lower-energy tracks.

The engine should avoid the same artist back-to-back, avoid a track repeat within 36 songs, and use weighted randomness rather than rigid blocks. Admin pins and scheduled items override ordinary rotation.

## Required server events

The playout worker publishes a single ordered event stream:
- `track_started`: track ID, title, artist, artwork, duration, started_at, stream item ID.
- `jingle_started`: jingle ID and started_at.
- `track_ended`: track ID and actual played duration.
- `schedule_changed`: revision and effective_at.

The API exposes `/api/euromix/now-playing` and returns the current item plus the server's canonical started_at. Android must render that metadata; it must not infer the current track from a local playlist or phone clock.

## Reliability

The worker must keep a pre-buffered next item, recover from a broken file by skipping it and recording an error, and never wait for an Android listener. Stream uptime and playlist progression must continue when all listeners disconnect.
