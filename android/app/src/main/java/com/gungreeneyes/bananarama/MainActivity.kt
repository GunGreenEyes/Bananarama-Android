package com.gungreeneyes.bananarama

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.StatusBarManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import com.gungreeneyes.bananarama.core.Gemini
import com.gungreeneyes.bananarama.core.ImageRequest
import com.gungreeneyes.bananarama.core.Inline
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * The whole UI is a local web page (assets/www, JavaScript). This activity hosts it, hands it
 * whatever was shared / selected / tapped, and exposes a small bridge (window.Android).
 */
class MainActivity : Activity() {
    lateinit var web: WebView
        private set
    private val prefs by lazy { Prefs(this) }
    private var pending: JSONObject? = null
    private var pageReady = false
    private var pickCallback: String? = null
    private var permCallback: String? = null
    private val jobListener = Jobs.Listener { ev -> js("bananarama.onJob(${ev})") }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifier.channels(this)
        val root = FrameLayout(this).apply { fitsSystemWindows = true }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true          // the page itself lives in file:///android_asset
            settings.allowContentAccess = false
            @Suppress("DEPRECATION") settings.allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") settings.allowUniversalAccessFromFileURLs = false
            addJavascriptInterface(Bridge(), "Android")
            webViewClient = object : WebViewClient() {
                // Never navigate away from the app's own page: links open in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.scheme == "file") return false
                    startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    return true
                }
                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    deliverPending()
                }
            }
        }
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        pending = payloadFor(intent)
        web.loadUrl("file:///android_asset/www/index.html")
        Jobs.listen(jobListener)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pending = payloadFor(intent)
        deliverPending()
    }

    override fun onResume() {
        super.onResume()
        if (pageReady) js("bananarama.onResume && bananarama.onResume()")
    }

    override fun onDestroy() {
        Jobs.unlisten(jobListener)
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("bananarama.back ? bananarama.back() : false") { handled ->
            @Suppress("DEPRECATION")
            if (handled != "true") super.onBackPressed()
        }
    }

    /** What the page should do for the intent that opened us. */
    private fun payloadFor(intent: Intent?): JSONObject? {
        intent ?: return null
        return when (intent.action) {
            Intent.ACTION_PROCESS_TEXT -> JSONObject().put("mode", "quick").put("source", "selection")
                .put("text", intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString().orEmpty())
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (stream != null && intent.type?.startsWith("image/") == true)
                    JSONObject().put("mode", "edit").put("source", "share").put("uri", stream.toString())
                        .put("thumb", ImageStore.thumbnail(this, stream) ?: JSONObject.NULL)
                else JSONObject().put("mode", "quick").put("source", "share")
                    .put("text", intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty())
            }
            ACTION_EDIT -> intent.data?.let { JSONObject().put("mode", "edit").put("source", "notification").put("uri", it.toString())
                .put("thumb", ImageStore.thumbnail(this, it) ?: JSONObject.NULL) }
            ACTION_NEW -> JSONObject().put("mode", "new")
            ACTION_SETTINGS -> JSONObject().put("mode", "settings")
            else -> null
        }
    }

    private fun deliverPending() {
        val p = pending ?: return
        if (!pageReady) return
        pending = null
        js("bananarama.onIntent($p)")
    }

    fun js(code: String) = runOnUiThread { if (!isDestroyed) web.evaluateJavascript(code, null) }

    private fun resolve(cb: String?, value: Any?) {
        if (cb == null) return
        js("bananarama.resolve(${JSONObject.quote(cb)}, ${value ?: "null"})")
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK) {
            val uri = if (resultCode == RESULT_OK) data?.data else null
            val result = uri?.let { JSONObject().put("uri", it.toString()).put("thumb", ImageStore.thumbnail(this, it) ?: JSONObject.NULL) }
            resolve(pickCallback, result); pickCallback = null
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERM) { resolve(permCallback, state().toString()); permCallback = null }
    }

    fun state(): JSONObject = JSONObject()
        .put("settings", prefs.toJson())
        .put("version", BuildConfig.VERSION_NAME)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("notifications", if (Build.VERSION.SDK_INT < 33) "not-needed" else if (Permissions.notificationsAllowed(this)) "granted" else "ask")
        .put("storage", if (Permissions.storageNeeded(this)) "ask" else "ok")
        .put("batteryUnrestricted", Permissions.batteryUnrestricted(this))
        .put("apiRunning", ApiService.running)
        .put("canAddTile", Build.VERSION.SDK_INT >= 33)
        .put("canPinShortcut", getSystemService(ShortcutManager::class.java)?.isRequestPinShortcutSupported == true)

    /** window.Android in the page. Strings in, strings (JSON) out. Runs on a WebView thread. */
    inner class Bridge {
        @JavascriptInterface fun state(): String = this@MainActivity.state().toString()

        @JavascriptInterface fun saveSettings(json: String): String {
            prefs.update(JSONObject(json))
            return prefs.toJson().toString()
        }

        @JavascriptInterface fun setApiKey(key: String): String { prefs.apiKey = key; return prefs.toJson().toString() }

        /** Checks a key (and the chosen model) against Google; answers through bananarama.resolve(cb, result). */
        @JavascriptInterface fun checkKey(key: String, model: String, cb: String) {
            Thread {
                val d = prefs.defaults().copy(apiKey = key.trim(), model = model.ifBlank { prefs.model })
                val r = Gemini(d).checkKey()
                val kind = when (r) { is Gemini.KeyCheck.Ok -> "ok"; is Gemini.KeyCheck.ModelMissing -> "model"; is Gemini.KeyCheck.Invalid -> "invalid"; else -> "failed" }
                resolve(cb, JSONObject().put("kind", kind).put("message", r.message).toString())
            }.start()
        }

        /** Starts an image in the background service; returns its job id. */
        @JavascriptInterface fun generate(json: String): String {
            val j = JSONObject(json)
            val inline = Inline.parse(j.optString("prompt"))
            val req = ImageRequest(
                prompt = inline.prompt,
                model = j.optString("model").ifBlank { null } ?: inline.model,
                aspectRatio = j.optString("aspectRatio").ifBlank { null } ?: inline.aspectRatio,
                imageSize = j.optString("imageSize").ifBlank { null } ?: inline.imageSize
            )
            if (req.prompt.isBlank()) return JSONObject().put("error", "Describe the image first.").toString()
            val id = UUID.randomUUID().toString().take(8)
            var refPath: String? = null
            var refMime: String? = null
            j.optString("refUri").takeIf { it.isNotBlank() }?.let { s ->
                try {
                    val ref = ImageStore.readReference(this@MainActivity, Uri.parse(s))
                    val f = File(cacheDir, "ref_$id.b64").apply { writeText(ref.base64) }
                    refPath = f.absolutePath; refMime = ref.mimeType
                } catch (e: Exception) {
                    return JSONObject().put("error", "Couldn't read that image: ${e.message}").toString()
                }
            }
            startForegroundService(GenerateService.intent(this@MainActivity, id, req, refPath, refMime))
            return JSONObject().put("id", id).put("prompt", req.prompt).toString()
        }

        @JavascriptInterface fun recent(limit: Int): String {
            val arr = JSONArray()
            ImageStore.recent(this@MainActivity, prefs.subfolder, limit).forEach {
                arr.put(JSONObject().put("uri", it.uri.toString()).put("name", it.name).put("date", it.dateAdded))
            }
            return arr.toString()
        }

        @JavascriptInterface fun thumb(uri: String): String? = ImageStore.thumbnail(this@MainActivity, Uri.parse(uri))

        @JavascriptInterface fun pickImage(cb: String) {
            pickCallback = cb
            runOnUiThread {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), REQ_PICK)
            }
        }

        @JavascriptInterface fun open(uri: String) {
            runOnUiThread { tryStart(Notifier.viewIntent(Uri.parse(uri), contentResolver.getType(Uri.parse(uri)) ?: "image/*")) }
        }

        @JavascriptInterface fun share(uri: String) {
            runOnUiThread { tryStart(Notifier.shareIntent(this@MainActivity, Uri.parse(uri), contentResolver.getType(Uri.parse(uri)) ?: "image/png")) }
        }

        @JavascriptInterface fun openUrl(url: String) {
            if (url.startsWith("https://")) runOnUiThread { tryStart(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }

        @JavascriptInterface fun openApp(pkg: String) {
            runOnUiThread {
                val i = packageManager.getLaunchIntentForPackage(pkg)
                if (i != null) tryStart(i) else tryStart(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg")))
            }
        }

        @JavascriptInterface fun isInstalled(pkg: String): Boolean = packageManager.getLaunchIntentForPackage(pkg) != null

        @JavascriptInterface fun requestNotifications(cb: String) {
            val perms = mutableListOf<String>()
            if (Build.VERSION.SDK_INT >= 33 && !Permissions.notificationsAllowed(this@MainActivity)) perms += Manifest.permission.POST_NOTIFICATIONS
            if (Permissions.storageNeeded(this@MainActivity)) perms += Manifest.permission.WRITE_EXTERNAL_STORAGE
            if (perms.isEmpty()) { resolve(cb, this@MainActivity.state().toString()); return }
            permCallback = cb
            runOnUiThread { requestPermissions(perms.toTypedArray(), REQ_PERM) }
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface fun requestBatteryUnrestricted() {
            runOnUiThread {
                tryStart(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
        }

        @JavascriptInterface fun openNotificationSettings() {
            runOnUiThread { tryStart(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) }
        }

        @JavascriptInterface fun addTile(cb: String) {
            if (Build.VERSION.SDK_INT < 33) { resolve(cb, "\"unsupported\""); return }
            runOnUiThread {
                getSystemService(StatusBarManager::class.java).requestAddTileService(
                    ComponentName(this@MainActivity, NewImageTile::class.java), getString(R.string.tile_label),
                    Icon.createWithResource(this@MainActivity, R.drawable.ic_stat_banana), mainExecutor
                ) { result -> resolve(cb, JSONObject.quote(result.toString())) }
            }
        }

        @JavascriptInterface fun pinShortcut() {
            val sm = getSystemService(ShortcutManager::class.java) ?: return
            val info = ShortcutInfo.Builder(this@MainActivity, "pinned-new")
                .setShortLabel(getString(R.string.shortcut_new_short))
                .setLongLabel(getString(R.string.shortcut_new_long))
                .setIcon(Icon.createWithResource(this@MainActivity, R.mipmap.ic_launcher))
                .setIntent(Intent(this@MainActivity, MainActivity::class.java).setAction(ACTION_NEW))
                .build()
            runOnUiThread { sm.requestPinShortcut(info, null) }
        }

        @JavascriptInterface fun setLocalApi(on: Boolean, port: Int): String {
            prefs.port = port
            prefs.localApi = on
            val i = Intent(this@MainActivity, ApiService::class.java)
            if (on) startForegroundService(i) else startService(i.setAction(ApiService.ACTION_STOP))
            return state().toString()
        }

        @JavascriptInterface fun copy(text: String) {
            runOnUiThread {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Bananarama", text))
                if (Build.VERSION.SDK_INT < 33) Toast.makeText(this@MainActivity, R.string.copied, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface fun toast(text: String) { runOnUiThread { Toast.makeText(this@MainActivity, text, Toast.LENGTH_SHORT).show() } }

        /** Quick mode: go back to the app the text came from. */
        @JavascriptInterface fun close() { runOnUiThread { moveTaskToBack(true) } }
    }

    private fun tryStart(i: Intent) {
        try { startActivity(i) } catch (e: Exception) { Toast.makeText(this, e.message ?: "Couldn't open that", Toast.LENGTH_SHORT).show() }
    }

    companion object {
        const val ACTION_NEW = "com.gungreeneyes.bananarama.NEW"
        const val ACTION_EDIT = "com.gungreeneyes.bananarama.EDIT"
        const val ACTION_SETTINGS = "com.gungreeneyes.bananarama.SETTINGS"
        private const val REQ_PICK = 1
        private const val REQ_PERM = 2
    }
}
