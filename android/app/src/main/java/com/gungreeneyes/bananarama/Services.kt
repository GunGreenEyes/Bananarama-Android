package com.gungreeneyes.bananarama

import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import com.gungreeneyes.bananarama.core.Gemini
import com.gungreeneyes.bananarama.core.ImageRequest
import com.gungreeneyes.bananarama.core.LocalApi
import com.gungreeneyes.bananarama.core.RefImage
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Makes images in the background (a foreground service, so Android lets it finish even after
 * you switch back to Claude). Jobs run one at a time; the service stops when the queue is empty.
 */
class GenerateService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val queued = AtomicInteger()
    @Volatile private var lastStartId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        Notifier.channels(this)
        val prompt = intent?.getStringExtra(EXTRA_PROMPT)?.trim().orEmpty()
        val label = if (prompt.length > 60) prompt.take(57) + "…" else prompt
        startInForeground(Notifier.progress(this, label.ifEmpty { "…" }))
        if (prompt.isEmpty()) { finishIfIdle(); return START_NOT_STICKY }

        val id = intent?.getStringExtra(EXTRA_ID) ?: System.currentTimeMillis().toString()
        val refPath = intent?.getStringExtra(EXTRA_REF_PATH)
        val refMime = intent?.getStringExtra(EXTRA_REF_MIME)
        val req = ImageRequest(
            prompt = prompt,
            model = intent?.getStringExtra(EXTRA_MODEL),
            aspectRatio = intent?.getStringExtra(EXTRA_RATIO),
            imageSize = intent?.getStringExtra(EXTRA_SIZE)
        )
        queued.incrementAndGet()
        executor.execute {
            try {
                val refs = if (refPath != null) listOf(RefImage(refMime ?: "image/jpeg", File(refPath).readText())) else emptyList()
                Jobs.run(this, id, req.copy(images = refs)) { detail -> startInForeground(Notifier.progress(this, label, detail)) }
            } catch (e: Throwable) {
                val msg = e.message ?: e.toString()
                Log.w(TAG, "image failed: $msg")
                Notifier.failed(this, msg)
                Jobs.emit(JSONObject().put("type", "error").put("id", id).put("message", msg))
            } finally {
                refPath?.let { File(it).delete() }
                if (queued.decrementAndGet() == 0) finishIfIdle()
            }
        }
        return START_NOT_STICKY
    }

    private fun startInForeground(n: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= 29) startForeground(Notifier.ID_JOB, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(Notifier.ID_JOB, n)
    }

    private fun finishIfIdle() {
        if (queued.get() > 0) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(lastStartId)
    }

    override fun onDestroy() { executor.shutdown(); super.onDestroy() }

    companion object {
        const val TAG = "Bananarama"
        const val EXTRA_ID = "id"
        const val EXTRA_PROMPT = "prompt"
        const val EXTRA_MODEL = "model"
        const val EXTRA_RATIO = "aspectRatio"
        const val EXTRA_SIZE = "imageSize"
        const val EXTRA_REF_PATH = "refPath"
        const val EXTRA_REF_MIME = "refMime"

        fun intent(context: Context, id: String, req: ImageRequest, refPath: String? = null, refMime: String? = null) =
            Intent(context, GenerateService::class.java)
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_PROMPT, req.prompt)
                .putExtra(EXTRA_MODEL, req.model).putExtra(EXTRA_RATIO, req.aspectRatio).putExtra(EXTRA_SIZE, req.imageSize)
                .putExtra(EXTRA_REF_PATH, refPath).putExtra(EXTRA_REF_MIME, refMime)
    }
}

/**
 * Optional: the Windows middleware's HTTP protocol on 127.0.0.1, so Claude Code in Termux
 * (the bananarama command and the /image skill) can use this app.
 */
class ApiService : Service() {
    private var api: LocalApi? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = Prefs(this)
        if (intent?.action == ACTION_STOP) {
            prefs.localApi = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        Notifier.channels(this)
        val n = Notifier.api(this, prefs.port)
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifier.ID_API, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(Notifier.ID_API, n)
        if (api == null) {
            try {
                api = LocalApi(prefs.port, BuildConfig.VERSION_NAME.removePrefix("v") + ".0.0") { req, listener ->
                    Gemini(Prefs(this).defaults()).generate(req, listener)
                }.also { it.start() }
                running = true
            } catch (e: Exception) {
                Notifier.failed(this, "Claude Code link could not start on port ${prefs.port}: ${e.message}")
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        api?.stop(); api = null; running = false
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "com.gungreeneyes.bananarama.STOP_API"
        @Volatile var running = false
    }
}

/** Starts the Claude Code link after a reboot, if it was on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Prefs(context).localApi) {
            context.startForegroundService(Intent(context, ApiService::class.java))
        }
    }
}

/** Quick Settings tile: "New image". */
class NewImageTile : TileService() {
    override fun onStartListening() {
        qsTile?.apply { state = Tile.STATE_INACTIVE; updateTile() }
    }

    override fun onClick() {
        val intent = Notifier.appIntent(this, MainActivity.ACTION_NEW)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 7, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
