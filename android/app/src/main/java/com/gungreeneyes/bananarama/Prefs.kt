package com.gungreeneyes.bananarama

import android.content.Context
import com.gungreeneyes.bananarama.core.Defaults
import com.gungreeneyes.bananarama.core.Models
import org.json.JSONObject

/** App settings (private to the app; the API key never leaves the phone except to Google). */
class Prefs(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("bananarama", Context.MODE_PRIVATE)

    var apiKey: String
        get() = p.getString("apiKey", "") ?: ""
        set(v) = p.edit().putString("apiKey", v.trim()).apply()
    var model: String
        get() = p.getString("model", Models.DEFAULT) ?: Models.DEFAULT
        set(v) = p.edit().putString("model", v).apply()
    var aspectRatio: String
        get() = p.getString("aspectRatio", "1:1") ?: "1:1"
        set(v) = p.edit().putString("aspectRatio", v).apply()
    var imageSize: String
        get() = p.getString("imageSize", "1K") ?: "1K"
        set(v) = p.edit().putString("imageSize", v).apply()
    var subfolder: String
        get() = p.getString("subfolder", "Nano") ?: "Nano"
        set(v) = p.edit().putString("subfolder", v.replace(Regex("[\\\\/:*?\"<>|]"), "").trim().ifEmpty { "Nano" }).apply()
    var notify: Boolean
        get() = p.getBoolean("notify", true)
        set(v) = p.edit().putBoolean("notify", v).apply()
    var openAfterSave: Boolean
        get() = p.getBoolean("openAfterSave", false)
        set(v) = p.edit().putBoolean("openAfterSave", v).apply()
    var confirmShares: Boolean
        get() = p.getBoolean("confirmShares", true)
        set(v) = p.edit().putBoolean("confirmShares", v).apply()
    var localApi: Boolean
        get() = p.getBoolean("localApi", false)
        set(v) = p.edit().putBoolean("localApi", v).apply()
    var port: Int
        get() = p.getInt("port", 7861)
        set(v) = p.edit().putInt("port", v.coerceIn(1024, 65535)).apply()
    var setupDone: Boolean
        get() = p.getBoolean("setupDone", false)
        set(v) = p.edit().putBoolean("setupDone", v).apply()
    /** Overridable for tests only. */
    var apiBase: String
        get() = p.getString("apiBase", DEFAULT_BASE) ?: DEFAULT_BASE
        set(v) = p.edit().putString("apiBase", v).apply()

    fun defaults() = Defaults(apiKey = apiKey, model = model, aspectRatio = aspectRatio, imageSize = imageSize, apiBase = apiBase)

    /** What the UI sees. The key is only ever shown masked. */
    fun toJson(): JSONObject = JSONObject()
        .put("hasKey", apiKey.isNotBlank())
        .put("keyHint", mask(apiKey))
        .put("model", model).put("aspectRatio", aspectRatio).put("imageSize", imageSize)
        .put("subfolder", subfolder).put("notify", notify).put("openAfterSave", openAfterSave)
        .put("confirmShares", confirmShares).put("localApi", localApi).put("port", port).put("setupDone", setupDone)

    /** Apply the fields the UI sends (unknown fields are ignored; the key has its own setter). */
    fun update(j: JSONObject) {
        if (j.has("model")) model = j.getString("model").ifBlank { Models.DEFAULT }
        if (j.has("aspectRatio") && j.getString("aspectRatio") in Models.RATIOS) aspectRatio = j.getString("aspectRatio")
        if (j.has("imageSize") && j.getString("imageSize") in Models.SIZES) imageSize = j.getString("imageSize")
        if (j.has("subfolder")) subfolder = j.getString("subfolder")
        if (j.has("notify")) notify = j.getBoolean("notify")
        if (j.has("openAfterSave")) openAfterSave = j.getBoolean("openAfterSave")
        if (j.has("confirmShares")) confirmShares = j.getBoolean("confirmShares")
        if (j.has("port")) port = j.getInt("port")
        if (j.has("setupDone")) setupDone = j.getBoolean("setupDone")
    }

    companion object {
        const val DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
        fun mask(key: String) = if (key.length < 8) (if (key.isEmpty()) "" else "••••") else "${key.take(4)}••••${key.takeLast(4)}"
    }
}
