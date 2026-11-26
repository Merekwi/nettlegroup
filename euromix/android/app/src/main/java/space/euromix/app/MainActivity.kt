package space.euromix.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

private val Purple = Color(0xFFB99BFF)
private val Bg = Color(0xFF0C0B14)
private val Panel = Color(0xFF1B1829)

class MainActivity : ComponentActivity() {
    private lateinit var player: ExoPlayer

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        player = ExoPlayer.Builder(this).build()
        if (Config.STREAM_URL.isNotBlank()) {
            player.setMediaItem(MediaItem.fromUri(Config.STREAM_URL))
            player.prepare()
        }
        setContent {
            var playing by remember { mutableStateOf(false) }
            var notice by remember { mutableStateOf(if (Config.STREAM_URL.isBlank()) "Радиосервер ещё не подключён" else "Готово к воспроизведению") }
            var page by remember { mutableStateOf("radio") }
            DisposableEffect(player) {
                val listener = object : Player.Listener {
                    override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
                    override fun onPlayerError(error: PlaybackException) { notice = "Не удалось подключиться к эфиру" }
                }
                player.addListener(listener)
                onDispose { player.removeListener(listener) }
            }
            MaterialTheme(colorScheme = darkColorScheme(primary = Purple, background = Bg, surface = Panel)) {
                Scaffold(containerColor = Bg, bottomBar = {
                    NavigationBar(containerColor = Panel) {
                        NavigationBarItem(selected = page == "radio", onClick = { page = "radio" }, icon = { Icon(Icons.Default.Radio, null) }, label = { Text("Эфир") })
                        NavigationBarItem(selected = page == "admin", onClick = { page = "admin" }, icon = { Icon(Icons.Default.Settings, null) }, label = { Text("Админ") })
                    }
                }) { padding ->
                    if (page == "radio") {
                        RadioPage(padding, playing, notice) {
                            if (Config.STREAM_URL.isBlank()) notice = "Эфир станет доступен после запуска сервера"
                            else if (player.isPlaying) player.pause() else player.play()
                        }
                    } else {
                        AdminPage(padding) {
                            if (Config.VERIFY_URL.isBlank()) notice = "Вход через NettleGroup Verify подключается на серверном этапе"
                            else startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.VERIFY_URL)))
                        }
                    }
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        // ExoPlayer remains alive for this activity instance; production background playback
        // will be moved to a MediaSessionService when the radio backend is connected.
    }

    override fun onDestroy() {
        player.release()
        super.onDestroy()
    }
}

@Composable
private fun RadioPage(padding: PaddingValues, playing: Boolean, notice: String, toggle: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(padding).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("EUROMIX", color = Color.White, fontSize = 25.sp, fontWeight = FontWeight.Black, letterSpacing = 5.sp)
        Spacer(Modifier.height(34.dp))
        Box(
            Modifier.size(250.dp).background(
                Brush.linearGradient(listOf(Color(0xFF6542A6), Color(0xFFD34F91), Color(0xFF303A78))),
                RoundedCornerShape(34.dp)
            ),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("EURO", fontSize = 40.sp, fontWeight = FontWeight.Black)
                Text("MIX", fontSize = 52.sp, fontWeight = FontWeight.Black, letterSpacing = 7.sp)
                Text("RADIO", fontSize = 12.sp, letterSpacing = 6.sp)
            }
        }
        Spacer(Modifier.height(28.dp))
        Surface(color = Color(0xFF30233E), shape = CircleShape) {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(if (Config.STREAM_URL.isBlank()) Color.Gray else Color(0xFFFF5577), CircleShape))
                Spacer(Modifier.width(8.dp))
                Text(if (Config.STREAM_URL.isBlank()) "ЭФИР НЕ ПОДКЛЮЧЁН" else "ПРЯМОЙ ЭФИР", fontSize = 11.sp, letterSpacing = 1.2.sp)
            }
        }
        Spacer(Modifier.height(16.dp))
        Text("Euromix Radio", fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Text("Европейские хиты и музыка конкурса", color = Color.LightGray)
        Spacer(Modifier.height(24.dp))
        FilledIconButton(onClick = toggle, modifier = Modifier.size(76.dp), enabled = Config.STREAM_URL.isNotBlank()) {
            Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, null, modifier = Modifier.size(42.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(notice, color = Color.Gray, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        Text("Единый синхронный эфир для всех слушателей", color = Color.Gray, fontSize = 12.sp)
    }
}

@Composable
private fun AdminPage(padding: PaddingValues, onVerify: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(padding).padding(20.dp)) {
        Text("Управление эфиром", fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Text("Администрирование музыкальной библиотеки", color = Color.Gray, fontSize = 13.sp)
        Spacer(Modifier.height(20.dp))
        Card(colors = CardDefaults.cardColors(containerColor = Panel)) {
            Column(Modifier.padding(18.dp)) {
                Icon(Icons.Default.VerifiedUser, contentDescription = null, tint = Purple, modifier = Modifier.size(30.dp))
                Spacer(Modifier.height(10.dp))
                Text("NettleGroup Verify", fontWeight = FontWeight.Bold)
                Text("Администраторский доступ будет выдаваться только после проверки существующей учётной записи NettleGroup. Отдельная регистрация и ручной API-ключ не используются.", color = Color.Gray, fontSize = 13.sp)
                Spacer(Modifier.height(14.dp))
                OutlinedButton(onClick = onVerify, modifier = Modifier.fillMaxWidth()) { Text("Войти через NettleGroup Verify") }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text("Загрузка треков, джинглов, правила перебивок и расписание появятся после подключения защищённого серверного API.", color = Color.Gray, fontSize = 12.sp)
    }
}
