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
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

private val Accent = Color(0xFFFF5C9A)
private val Violet = Color(0xFF9275FF)
private val Background = Color(0xFF090A12)
private val SurfaceDark = Color(0xFF151725)
private val Muted = Color(0xFF9296AA)

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
            var notice by remember { mutableStateOf(if (Config.STREAM_URL.isBlank()) "Подключаем радиостанцию" else "Подключение к прямому эфиру") }
            var page by remember { mutableStateOf("radio") }
            var accountName by remember { mutableStateOf<String?>(null) }
            var isAdmin by remember { mutableStateOf(false) }
            var trackTitle by remember { mutableStateOf("Музыка без границ") }
            var trackArtist by remember { mutableStateOf("Euromix Radio") }

            DisposableEffect(player) {
                val listener = object : Player.Listener {
                    override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
                    override fun onPlayerError(error: PlaybackException) { notice = "Не удалось подключиться к эфиру" }
                }
                player.addListener(listener)
                onDispose { player.removeListener(listener) }
            }

            MaterialTheme(colorScheme = darkColorScheme(
                primary = Accent, secondary = Violet, background = Background,
                surface = SurfaceDark, onBackground = Color.White, onSurface = Color.White
            )) {
                Scaffold(containerColor = Background) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        TopBar(onAccount = { page = if (page == "account") "radio" else "account" }, onRadio = { page = "radio" }, accountPage = page == "account")
                        when (page) {
                            "account" -> AccountPage(
                                accountName = accountName,
                                isAdmin = isAdmin,
                                onVerify = {
                                    if (Config.VERIFY_URL.isNotBlank()) {
                                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.VERIFY_URL)))
                                    } else {
                                        notice = "Авторизация NettleGroup Verify будет доступна после подключения защищённого входа"
                                    }
                                },
                                onAdmin = { page = "admin" }
                            )
                            "admin" -> if (isAdmin) AdminPage() else RadioPage(
                                playing, notice, trackTitle, trackArtist,
                                onToggle = { if (Config.STREAM_URL.isNotBlank()) { if (player.isPlaying) player.pause() else player.play() } }
                            )
                            else -> RadioPage(
                                playing, notice, trackTitle, trackArtist,
                                onToggle = {
                                    if (Config.STREAM_URL.isBlank()) notice = "Прямой эфир скоро появится"
                                    else if (player.isPlaying) player.pause() else player.play()
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        player.release()
        super.onDestroy()
    }
}

@Composable
private fun TopBar(onAccount: () -> Unit, onRadio: () -> Unit, accountPage: Boolean) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).background(Brush.linearGradient(listOf(Accent, Violet)), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center
            ) { Text("E", fontSize = 25.sp, fontWeight = FontWeight.Black, color = Color.White) }
            Spacer(Modifier.width(11.dp))
            Column {
                Text("EUROMIX", fontSize = 17.sp, fontWeight = FontWeight.Black, letterSpacing = 3.sp)
                Text("RADIO", fontSize = 9.sp, color = Muted, letterSpacing = 3.sp)
            }
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = if (accountPage) onRadio else onAccount) {
            Icon(if (accountPage) Icons.Default.Close else Icons.Outlined.AccountCircle, contentDescription = "Аккаунт", tint = Color.White, modifier = Modifier.size(29.dp))
        }
    }
}

@Composable
private fun RadioPage(
    playing: Boolean,
    notice: String,
    title: String,
    artist: String,
    onToggle: () -> Unit
) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(Modifier.height(18.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(if (Config.STREAM_URL.isBlank()) Muted else Accent, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(if (Config.STREAM_URL.isBlank()) "РАДИО ГОТОВИТСЯ К ЭФИРУ" else "В ПРЯМОМ ЭФИРЕ", color = if (Config.STREAM_URL.isBlank()) Muted else Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
        }
        Spacer(Modifier.height(28.dp))
        Box(
            Modifier.fillMaxWidth().aspectRatio(1f).padding(horizontal = 22.dp)
                .background(Brush.linearGradient(listOf(Color(0xFF40245F), Color(0xFF9B326D), Color(0xFF242D60))), RoundedCornerShape(34.dp)),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("EURO", fontSize = 48.sp, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
                Text("MIX", fontSize = 62.sp, fontWeight = FontWeight.Black, letterSpacing = 8.sp)
                Spacer(Modifier.height(4.dp))
                Text("MUSIC • LIVE • TOGETHER", fontSize = 9.sp, letterSpacing = 2.sp, color = Color.White.copy(alpha = .8f))
            }
            Row(Modifier.align(Alignment.BottomCenter).padding(bottom = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                repeat(5) { i ->
                    Box(Modifier.padding(horizontal = 3.dp).width(3.dp).height((9 + (i % 3) * 7).dp).background(Color.White.copy(alpha = .8f), CircleShape))
                }
            }
        }
        Spacer(Modifier.height(28.dp))
        Column(Modifier.fillMaxWidth()) {
            Text("СЕЙЧАС ИГРАЕТ", color = Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.8.sp)
            Spacer(Modifier.height(8.dp))
            Text(if (Config.STREAM_URL.isBlank()) "Ожидаем запуск эфира" else title, fontSize = 23.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(if (Config.STREAM_URL.isBlank()) "Здесь появятся название трека и исполнитель" else artist, color = Muted, fontSize = 14.sp)
        }
        Spacer(Modifier.height(22.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(3.dp).background(Color(0xFF34364A), CircleShape))
            Spacer(Modifier.width(8.dp))
            Text("LIVE", color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(22.dp))
        FilledIconButton(
            onClick = onToggle,
            modifier = Modifier.size(72.dp),
            enabled = Config.STREAM_URL.isNotBlank(),
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = Accent, disabledContainerColor = Color(0xFF343044))
        ) {
            Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "Воспроизвести", modifier = Modifier.size(38.dp), tint = Color.White)
        }
        Spacer(Modifier.height(13.dp))
        Text(if (playing) "Вы слушаете Euromix" else notice, color = Muted, fontSize = 12.sp)
        Spacer(Modifier.weight(1f))
        Text("ОДИН ЭФИР ДЛЯ ВСЕХ СЛУШАТЕЛЕЙ", color = Color(0xFF656A80), fontSize = 9.sp, letterSpacing = 1.5.sp)
        Spacer(Modifier.height(22.dp))
    }
}

@Composable
private fun AccountPage(accountName: String?, isAdmin: Boolean, onVerify: () -> Unit, onAdmin: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(22.dp)) {
        Spacer(Modifier.height(12.dp))
        Text("Аккаунт", fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text("Ваш профиль Euromix", color = Muted, fontSize = 14.sp)
        Spacer(Modifier.height(26.dp))
        Card(colors = CardDefaults.cardColors(containerColor = SurfaceDark), shape = RoundedCornerShape(24.dp)) {
            Column(Modifier.fillMaxWidth().padding(20.dp)) {
                Icon(Icons.Outlined.AccountCircle, contentDescription = null, tint = Violet, modifier = Modifier.size(42.dp))
                Spacer(Modifier.height(14.dp))
                Text(accountName ?: "Гость", fontSize = 21.sp, fontWeight = FontWeight.Bold)
                Text(if (accountName == null) "Вы не вошли в NettleGroup" else "Аккаунт подтверждён", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(18.dp))
                Button(onClick = onVerify, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp)) {
                    Icon(Icons.Default.VerifiedUser, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (accountName == null) "Войти через NettleGroup" else "Проверить аккаунт")
                }
            }
        }
        if (isAdmin) {
            Spacer(Modifier.height(18.dp))
            Card(onClick = onAdmin, colors = CardDefaults.cardColors(containerColor = Color(0xFF29213B)), shape = RoundedCornerShape(20.dp)) {
                Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Tune, contentDescription = null, tint = Accent)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Управление станцией", fontWeight = FontWeight.Bold)
                        Text("Музыка, джинглы и расписание", color = Muted, fontSize = 12.sp)
                    }
                    Icon(Icons.Default.ChevronRight, contentDescription = null)
                }
            }
        }
    }
}

@Composable
private fun AdminPage() {
    Column(Modifier.fillMaxSize().padding(22.dp)) {
        Text("Управление станцией", fontSize = 27.sp, fontWeight = FontWeight.Bold)
        Text("Панель доступна только подтверждённым администраторам.", color = Muted)
    }
}
