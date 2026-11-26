package space.euromix.app

import android.content.Intent
import android.content.Context
import android.content.ComponentName
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
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
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.Executor

private val Accent = Color(0xFFFF5C9A)
private val Violet = Color(0xFF9275FF)
private val Background = Color(0xFF090A12)
private val SurfaceDark = Color(0xFF151725)
private val Muted = Color(0xFF9296AA)

private object SecureTokenStore {
    private const val PREFS = "euromix_secure"
    private const val TOKEN = "access_token"
    private const val KEY_ALIAS = "EuromixSessionKey"

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    fun read(context: Context): String? {
        return try {
            val encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(TOKEN, null)
                ?: return null
            val bytes = Base64.decode(encoded, Base64.NO_WRAP)
            if (bytes.size <= 12) return null
            val iv = bytes.copyOfRange(0, 12)
            val encrypted = bytes.copyOfRange(12, bytes.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        } catch (_: Exception) {
            clear(context)
            null
        }
    }

    fun save(context: Context, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val combined = cipher.iv + encrypted
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(TOKEN, Base64.encodeToString(combined, Base64.NO_WRAP)).apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(TOKEN).apply()
    }
}

class MainActivity : ComponentActivity() {
    private var player by mutableStateOf<MediaController?>(null)
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private val http = OkHttpClient()
    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var accessToken: String? = null
    private var accountNameState by mutableStateOf<String?>(null)
    private var adminState by mutableStateOf(false)
    private var authNoticeState by mutableStateOf("Войдите через NettleGroup Verify")
    private var authBusyState by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        accessToken = SecureTokenStore.read(this)
        connectPlaybackService()
        val incomingCode = intent?.data?.getQueryParameter("code")
        if (!incomingCode.isNullOrBlank()) {
            consumeAuthCode(incomingCode)
        } else if (accessToken != null) {
            refreshSession()
        }
        setContent {
            var playing by remember { mutableStateOf(false) }
            var notice by remember { mutableStateOf(if (Config.STREAM_URL.isBlank()) "Подключаем радиостанцию" else "Подключение к прямому эфиру") }
            var page by remember { mutableStateOf("radio") }
            var trackTitle by remember { mutableStateOf("Музыка без границ") }
            var trackArtist by remember { mutableStateOf("Euromix Radio") }

            DisposableEffect(player) {
                val activePlayer = player
                if (activePlayer == null) {
                    onDispose { }
                } else {
                    val listener = object : Player.Listener {
                        override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying }
                        override fun onPlayerError(error: PlaybackException) { notice = "Не удалось подключиться к эфиру" }
                    }
                    activePlayer.addListener(listener)
                    onDispose { activePlayer.removeListener(listener) }
                }
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
                                accountName = accountNameState,
                                isAdmin = adminState,
                                notice = authNoticeState,
                                loading = authBusyState,
                                onVerify = { openVerify() },
                                onAdmin = { page = "admin" }
                            )
                            "admin" -> if (adminState) AdminPage() else RadioPage(
                                playing, notice, trackTitle, trackArtist,
                                onToggle = { player?.let { if (it.isPlaying) it.pause() else it.play() } }
                            )
                            else -> RadioPage(
                                playing, notice, trackTitle, trackArtist,
                                onToggle = {
                                    if (Config.STREAM_URL.isBlank()) notice = "Прямой эфир скоро появится"
                                    else player?.let { if (it.isPlaying) it.pause() else it.play() }
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val uri = intent.data ?: return
        if (uri.scheme == "euromix" && uri.host == "auth" && uri.path == "/success") {
            uri.getQueryParameter("code")?.let { code ->
                if (code.isNotBlank()) consumeAuthCode(code)
            }
        }
    }

    private fun openVerify() {
        if (Config.VERIFY_URL.isBlank()) {
            authNoticeState = "Ссылка входа пока не настроена"
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Config.VERIFY_URL)))
        } catch (_: Exception) {
            authNoticeState = "Не удалось открыть страницу входа"
        }
    }

    private fun consumeAuthCode(code: String) {
        authBusyState = true
        authNoticeState = "Подтверждаем вход…"
        intent?.data = null
        activityScope.launch {
            try {
                val json = withContext(Dispatchers.IO) {
                    val body = JSONObject().put("code", code).toString()
                        .toRequestBody("application/json; charset=utf-8".toMediaType())
                    val request = Request.Builder()
                        .url(Config.API_BASE.trimEnd('/') + "/api/auth/mobile/exchange")
                        .post(body)
                        .build()
                    http.newCall(request).execute().use { response ->
                        val raw = response.body?.string().orEmpty()
                        val result = JSONObject(raw.ifBlank { "{}" })
                        if (!response.isSuccessful) {
                            throw IOException(result.optString("error", "Не удалось подтвердить вход"))
                        }
                        result
                    }
                }
                val token = json.getString("accessToken")
                val user = json.getJSONObject("user")
                SecureTokenStore.save(this@MainActivity, token)
                accessToken = token
                accountNameState = user.optString("displayName", "Пользователь")
                adminState = user.optBoolean("isAdmin", false)
                authNoticeState = "Аккаунт подключён"
            } catch (error: Exception) {
                authNoticeState = when (error.message) {
                    "invalid_or_expired_code" -> "Ссылка входа устарела. Нажмите «Войти» ещё раз."
                    else -> "Не удалось войти. Повторите попытку."
                }
            } finally {
                authBusyState = false
                intent?.data = null
            }
        }
    }

    private fun refreshSession() {
        val token = accessToken ?: return
        activityScope.launch {
            try {
                val json = withContext(Dispatchers.IO) {
                    val request = Request.Builder()
                        .url(Config.API_BASE.trimEnd('/') + "/api/session")
                        .header("Authorization", "Bearer " + token)
                        .get()
                        .build()
                    http.newCall(request).execute().use { response ->
                        val raw = response.body?.string().orEmpty()
                        val result = JSONObject(raw.ifBlank { "{}" })
                        if (!response.isSuccessful) throw IOException("session_unavailable")
                        result
                    }
                }
                if (!json.optBoolean("authenticated", false) || json.isNull("user")) {
                    SecureTokenStore.clear(this@MainActivity)
                    accessToken = null
                    accountNameState = null
                    adminState = false
                    authNoticeState = "Сессия истекла. Войдите снова."
                } else {
                    val user = json.getJSONObject("user")
                    accountNameState = user.optString("displayName", "Пользователь")
                    adminState = user.optBoolean("isAdmin", false)
                    authNoticeState = "Аккаунт подключён"
                }
            } catch (_: Exception) {
                authNoticeState = "Нет связи с сервером. Проверьте подключение."
            }
        }
    }

    private fun connectPlaybackService() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                player = future.get()
            } catch (_: Exception) {
                authNoticeState = "Не удалось подключить аудиоплеер"
            }
        }, Executor { command -> runOnUiThread(command) })
    }

    override fun onDestroy() {
        activityScope.cancel()
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        player = null
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
private fun AccountPage(accountName: String?, isAdmin: Boolean, notice: String, loading: Boolean, onVerify: () -> Unit, onAdmin: () -> Unit) {
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
                Text(if (accountName == null) "Вы не вошли в NettleGroup" else "Вход выполнен через Verify", color = Muted, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                Text(notice, color = Muted, fontSize = 12.sp)
                Spacer(Modifier.height(18.dp))
                Button(onClick = onVerify, enabled = !loading, modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp)) {
                    Icon(Icons.Default.VerifiedUser, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (loading) "Подтверждаем вход…" else if (accountName == null) "Войти через NettleGroup Verify" else "Переподключить аккаунт")
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
