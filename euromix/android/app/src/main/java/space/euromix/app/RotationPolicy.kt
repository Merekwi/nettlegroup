package space.euromix.app

import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.random.Random

/**
 * Rotation rules shared with the future 24/7 playout service.
 * The server must be the only authority that calls this policy and emits the stream.
 */
data class RadioTrack(
    val id: String,
    val title: String,
    val artist: String,
    val genres: Set<String> = emptySet(),
    val preferredHours: IntRange? = null,
    val priority: Int = 0,
    val plays: Int = 0,
    val lastPlayedAt: Instant? = null
)

data class RadioJingle(
    val id: String,
    val fileKey: String,
    val scheduledHours: Set<Int> = emptySet(),
    val beforeTrackId: String? = null
)

sealed interface RotationItem {
    data class Song(val track: RadioTrack) : RotationItem
    data class Jingle(val jingle: RadioJingle) : RotationItem
}

data class RotationMemory(
    val recentTrackIds: List<String> = emptyList(),
    val recentArtists: List<String> = emptyList(),
    val recentGenres: List<String> = emptyList(),
    val songsSinceJingle: Int = 0,
    val lastJingleAt: Instant? = null,
    val nextJingleAfterSongs: Int = 4
)

object RotationPolicy {
    private const val TRACK_COOLDOWN = 36
    private const val ARTIST_COOLDOWN = 4
    private const val GENRE_COOLDOWN = 2
    private const val MIN_JINGLE_GAP_SECONDS = 8 * 60L

    fun next(
        tracks: List<RadioTrack>,
        jingles: List<RadioJingle>,
        memory: RotationMemory,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.of("Europe/Moscow"),
        random: Random = Random.Default
    ): RotationItem? {
        if (tracks.isEmpty()) return null
        val hour = now.atZone(zone).hour

        val scheduled = jingles.firstOrNull { hour in it.scheduledHours }
        if (scheduled != null && canPlayJingle(memory, now)) return RotationItem.Jingle(scheduled)

        val nextSong = pickTrack(tracks, memory, now, hour, random) ?: return null
        val preRoll = jingles.firstOrNull { it.beforeTrackId == nextSong.id }
        if (preRoll != null && canPlayJingle(memory, now)) return RotationItem.Jingle(preRoll)

        if (memory.songsSinceJingle >= memory.nextJingleAfterSongs && canPlayJingle(memory, now)) {
            val candidates = jingles.filter { it.scheduledHours.isEmpty() && it.beforeTrackId == null }
            if (candidates.isNotEmpty()) return RotationItem.Jingle(candidates.random(random))
        }
        return RotationItem.Song(nextSong)
    }

    private fun canPlayJingle(memory: RotationMemory, now: Instant): Boolean {
        val last = memory.lastJingleAt ?: return true
        return now.epochSecond - last.epochSecond >= MIN_JINGLE_GAP_SECONDS
    }

    private fun pickTrack(
        tracks: List<RadioTrack>,
        memory: RotationMemory,
        now: Instant,
        hour: Int,
        random: Random
    ): RadioTrack? {
        val eligible = tracks.filter { it.id !in memory.recentTrackIds.take(TRACK_COOLDOWN) }
            .ifEmpty { tracks.filter { it.id !in memory.recentTrackIds.take(8) } }
            .ifEmpty { tracks }
        val scored = eligible.map { track ->
            var score = 100.0 + track.priority * 8.0
            if (track.artist in memory.recentArtists.take(ARTIST_COOLDOWN)) score *= 0.12
            if (track.genres.any { it in memory.recentGenres.take(GENRE_COOLDOWN) }) score *= 0.72
            if (track.preferredHours != null && hour !in track.preferredHours) score *= 0.35
            score *= 1.0 / (1.0 + max(0, track.plays) * 0.025)
            val ageMinutes = track.lastPlayedAt?.let { (now.epochSecond - it.epochSecond) / 60.0 } ?: 100000.0
            score *= (1.0 + (ageMinutes.coerceAtLeast(0.0) / 240.0).coerceAtMost(2.0))
            track to score.coerceAtLeast(0.01)
        }
        val total = scored.sumOf { it.second }
        var cursor = random.nextDouble(total)
        for ((track, weight) in scored) {
            cursor -= weight
            if (cursor <= 0.0) return track
        }
        return scored.lastOrNull()?.first
    }
}
