package com.gungreeneyes.bananarama.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.FilterInputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64

class GeminiException(message: String) : Exception(message)

/** What came back. [base64] is the final (non-"thought") image. */
class ImageResult(
    val base64: String,
    val mimeType: String,
    val texts: List<String>,
    val model: String,
    val finishReason: String?,
    val usage: JSONObject?
) {
    val bytes: ByteArray by lazy { Base64.getDecoder().decode(base64) }
}

interface GenerateListener {
    fun onStatus(message: String) {}
    fun onText(text: String) {}
    /** Bytes received so far from Gemini (the image arrives base64-encoded at the end of the stream). */
    fun onBytes(received: Long) {}
}

/** Server-sent events: calls [onData] with each event's data lines joined. Handles LF and CRLF. */
object Sse {
    fun read(input: InputStream, onData: (String) -> Unit) {
        val reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8), 64 * 1024)
        val data = StringBuilder()
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) {
                if (data.isNotEmpty()) { onData(data.toString()); data.setLength(0) }
                continue
            }
            if (line.startsWith("data:")) {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.substring(5).trimStart())
            }
        }
        if (data.isNotBlank()) onData(data.toString())
    }
}

/** Talks to the Gemini API directly (the Android app has no separate middleware process to hop through). */
class Gemini(private val defaults: Defaults, private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {

    fun requestBody(req: ImageRequest): Pair<String, JSONObject> {
        val model = Models.resolve(req.model) ?: defaults.model
        val imageConfig = JSONObject()
        (req.aspectRatio ?: defaults.aspectRatio).takeIf { it.isNotBlank() }?.let { imageConfig.put("aspectRatio", it) }
        val size = (req.imageSize ?: defaults.imageSize).uppercase()
        if (size.isNotBlank() && Models.supportsSize(model)) imageConfig.put("imageSize", size)
        val parts = JSONArray().put(JSONObject().put("text", req.prompt))
        for (img in req.images) parts.put(JSONObject().put("inlineData", JSONObject().put("mimeType", img.mimeType).put("data", img.base64)))
        val body = JSONObject()
            .put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", parts)))
            .put("generationConfig", JSONObject().put("responseModalities", JSONArray().put("TEXT").put("IMAGE")).put("imageConfig", imageConfig))
        return model to body
    }

    fun generate(req: ImageRequest, listener: GenerateListener = object : GenerateListener {}): ImageResult {
        if (req.prompt.isBlank()) throw GeminiException("a description is required")
        if (defaults.apiKey.isBlank()) throw GeminiException("no API key: add your Gemini API key in Bananarama's settings")
        val (model, body) = requestBody(req)
        val url = URL("${defaults.apiBase.trimEnd('/')}/models/${URLEncoder.encode(model, "UTF-8")}:streamGenerateContent?alt=sse")
        listener.onStatus("requesting $model (${body.getJSONObject("generationConfig").getJSONObject("imageConfig").optString("aspectRatio", "default")}, " +
            "${body.getJSONObject("generationConfig").getJSONObject("imageConfig").optString("imageSize", "default")})")
        val conn = open(url).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 30_000
            readTimeout = defaults.timeoutMs
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-goog-api-key", defaults.apiKey)
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) throw GeminiException("Gemini HTTP $code: ${errorMessage(conn)}")

            var image: String? = null
            var mime = "image/png"
            var finish: String? = null
            var usage: JSONObject? = null
            var blocked: String? = null
            val texts = mutableListOf<String>()
            val counting = Counting(conn.inputStream) { listener.onBytes(it) }
            Sse.read(counting) { data ->
                val ev = try { JSONObject(data) } catch (e: Exception) { return@read }
                ev.optJSONObject("usageMetadata")?.let { usage = it }
                ev.optJSONObject("promptFeedback")?.optString("blockReason")?.takeIf { it.isNotEmpty() }?.let { blocked = it }
                val cands = ev.optJSONArray("candidates") ?: return@read
                for (i in 0 until cands.length()) {
                    val cand = cands.getJSONObject(i)
                    cand.optString("finishReason").takeIf { it.isNotEmpty() }?.let { finish = it }
                    val parts = cand.optJSONObject("content")?.optJSONArray("parts") ?: continue
                    for (j in 0 until parts.length()) {
                        val p = parts.getJSONObject(j)
                        if (p.optBoolean("thought")) { listener.onStatus("thinking…"); continue }
                        p.optString("text").takeIf { it.isNotEmpty() }?.let { texts += it; listener.onText(it) }
                        val d = p.optJSONObject("inlineData") ?: p.optJSONObject("inline_data")
                        val b64 = d?.optString("data")
                        if (!b64.isNullOrEmpty()) {
                            image = b64
                            mime = d.optString("mimeType").ifEmpty { d.optString("mime_type").ifEmpty { "image/png" } }
                        }
                    }
                }
            }
            blocked?.let { if (image == null) throw GeminiException("prompt blocked: $it") }
            val img = image ?: throw GeminiException("no image returned (finishReason: ${finish ?: "unknown"})")
            return ImageResult(img, mime, texts, model, finish, usage)
        } finally {
            conn.disconnect()
        }
    }

    sealed class KeyCheck(val message: String) {
        class Ok(message: String) : KeyCheck(message)
        class ModelMissing(message: String) : KeyCheck(message)
        class Invalid(message: String) : KeyCheck(message)
        class Failed(message: String) : KeyCheck(message)
    }

    /** Lists models with the key and checks the configured model is available to it. */
    fun checkKey(): KeyCheck {
        if (defaults.apiKey.isBlank()) return KeyCheck.Invalid("Enter a key first.")
        return try {
            val conn = open(URL("${defaults.apiBase.trimEnd('/')}/models?pageSize=200")).apply {
                connectTimeout = 15_000; readTimeout = 15_000
                setRequestProperty("x-goog-api-key", defaults.apiKey)
            }
            try {
                when (val code = conn.responseCode) {
                    400, 401, 403 -> KeyCheck.Invalid("That key isn't valid.")
                    in 200..299 -> {
                        val models = JSONObject(conn.inputStream.bufferedReader().readText()).optJSONArray("models") ?: JSONArray()
                        val names = (0 until models.length()).map { models.getJSONObject(it).optString("name").removePrefix("models/") }
                        if (defaults.model in names) KeyCheck.Ok("Key works ✓")
                        else KeyCheck.ModelMissing("Key works, but ${defaults.model} isn't available to it.")
                    }
                    else -> KeyCheck.Failed("Couldn't check (HTTP $code).")
                }
            } finally { conn.disconnect() }
        } catch (e: Exception) {
            KeyCheck.Failed("Couldn't check: ${e.message}")
        }
    }

    private fun errorMessage(conn: HttpURLConnection): String {
        val raw = try { conn.errorStream?.bufferedReader()?.readText() ?: "" } catch (e: Exception) { "" }
        return try { JSONObject(raw).getJSONObject("error").getString("message") } catch (e: Exception) { raw.ifBlank { conn.responseMessage ?: "error" } }
    }

    private class Counting(input: InputStream, private val report: (Long) -> Unit) : FilterInputStream(input) {
        private var total = 0L
        private var last = 0L
        override fun read(): Int = super.read().also { if (it >= 0) add(1) }
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) add(it.toLong()) }
        private fun add(n: Long) { total += n; if (total - last >= 64 * 1024) { last = total; report(total) } }
    }
}
