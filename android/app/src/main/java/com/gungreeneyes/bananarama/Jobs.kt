package com.gungreeneyes.bananarama

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.gungreeneyes.bananarama.core.Gemini
import com.gungreeneyes.bananarama.core.GenerateListener
import com.gungreeneyes.bananarama.core.ImageRequest
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

object Permissions {
    fun notificationsAllowed(context: Context) = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun storageNeeded(context: Context) = Build.VERSION.SDK_INT < 29 &&
        context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED

    fun batteryUnrestricted(context: Context) =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
}

/** Job events for whoever is listening (the UI, tests). Delivered on the main thread. */
object Jobs {
    fun interface Listener { fun onEvent(event: JSONObject) }

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val main = Handler(Looper.getMainLooper())

    fun listen(l: Listener) { listeners += l }
    fun unlisten(l: Listener) { listeners -= l }

    fun emit(event: JSONObject) { main.post { listeners.forEach { it.onEvent(event) } } }

    /**
     * Make one image: Gemini -> Pictures/<subfolder> -> notification. Runs on the caller's thread.
     * @return the saved image; throws with a readable message on failure.
     */
    fun run(context: Context, id: String, req: ImageRequest, onUpdate: (String) -> Unit = {}): ImageStore.Saved {
        val prefs = Prefs(context)
        val label = if (req.prompt.length > 60) req.prompt.take(57) + "…" else req.prompt
        emit(JSONObject().put("type", "start").put("id", id).put("prompt", label))
        val gemini = Gemini(prefs.defaults())
        val result = gemini.generate(req, object : GenerateListener {
            override fun onStatus(message: String) {
                emit(JSONObject().put("type", "status").put("id", id).put("message", message))
            }
            override fun onBytes(received: Long) {
                val mb = String.format(java.util.Locale.US, "%.1f MB", received / 1048576.0)
                onUpdate("receiving $mb")
                emit(JSONObject().put("type", "bytes").put("id", id).put("received", received))
            }
        })
        val saved = ImageStore.save(context, result.bytes, result.mimeType, req.prompt, prefs.subfolder)
        if (prefs.notify) Notifier.done(context, saved, result.bytes)
        emit(JSONObject().put("type", "done").put("id", id).put("uri", saved.uri.toString()).put("name", saved.name)
            .put("mimeType", saved.mimeType).put("thumb", ImageStore.thumbnail(context, saved.uri) ?: JSONObject.NULL)
            .put("note", result.texts.joinToString(" ").trim()))
        return saved
    }
}
