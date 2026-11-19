package com.gungreeneyes.bananarama.core

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.Executors

/**
 * The phone's version of the Windows middleware: the same `GET /health` and `POST /imagine`
 * (NDJSON) protocol on 127.0.0.1, so the Bananarama command line and Claude Code in Termux
 * can use the app. Only local, non-browser requests are answered.
 *
 * @param generate runs one request (the app passes its settings); [onImage] lets the app
 *        also save/notify for API-made images if it wants.
 */
class LocalApi(
    private val port: Int,
    private val version: String,
    private val generate: (ImageRequest, GenerateListener) -> ImageResult
) {
    private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "bananarama-api").apply { isDaemon = true } }

    val boundPort: Int get() = server?.localPort ?: -1
    val running: Boolean get() = server?.isClosed == false

    fun start() {
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
        server = s
        pool.execute {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (e: SocketException) { break }
                pool.execute { handle(c) }
            }
        }
    }

    fun stop() {
        try { server?.close() } catch (e: Exception) { /* closing */ }
        server = null
    }

    private class Req(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    private fun readRequest(input: InputStream): Req? {
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val b = input.read()
            if (b < 0) return null
            head.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0d0a0d0a) break
            if (head.size() > 32 * 1024) return null
        }
        val lines = head.toString("ISO-8859-1").split("\r\n")
        val parts = lines[0].split(' ')
        if (parts.size < 2) return null
        val headers = lines.drop(1).filter { ':' in it }.associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len > 60 * 1024 * 1024) return null
        val body = ByteArray(len)
        var off = 0
        while (off < len) { val n = input.read(body, off, len - off); if (n < 0) break; off += n }
        return Req(parts[0], parts[1], headers, body)
    }

    /** Same guard as the Windows middleware: no browser Origin, local Host only. */
    fun allowed(headers: Map<String, String>): Boolean {
        if (headers.containsKey("origin")) return false
        val host = (headers["host"] ?: "").lowercase().replace(Regex(":\\d+$"), "")
        return host == "127.0.0.1" || host == "localhost" || host == "[::1]"
    }

    private fun handle(socket: Socket) {
        socket.use { s ->
            s.soTimeout = 30_000
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            val req = try { readRequest(input) } catch (e: Exception) { null } ?: return
            if (!allowed(req.headers)) return respond(out, 403, "application/json", """{"error":"forbidden"}""")
            when {
                req.method == "GET" && req.path == "/health" ->
                    respond(out, 200, "application/json", JSONObject().put("ok", true).put("name", "Bananarama").put("version", version)
                        .put("pid", ProcessHandleCompat.pid()).put("platform", "android").toString())
                req.method == "POST" && req.path == "/imagine" -> { s.soTimeout = 0; imagine(req, out) }
                else -> respond(out, 404, "application/json", """{"error":"not found"}""")
            }
        }
    }

    private fun imagine(req: Req, out: OutputStream) {
        out.write("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".toByteArray())
        val send = { ev: JSONObject -> out.write((ev.toString() + "\n").toByteArray(Charsets.UTF_8)); out.flush() }
        val input = try { JSONObject(String(req.body, Charsets.UTF_8).ifBlank { "{}" }) } catch (e: Exception) {
            send(JSONObject().put("type", "error").put("message", "bad request JSON: ${e.message}")); return
        }
        val prompt = input.optString("prompt").trim()
        if (prompt.isEmpty()) { send(JSONObject().put("type", "error").put("message", "prompt is required")); return }
        val images = input.optJSONArray("images")?.let { arr ->
            (0 until arr.length()).map { arr.getJSONObject(it).let { o -> RefImage(o.optString("mimeType"), o.optString("data")) } }
        } ?: emptyList()
        val r = ImageRequest(prompt, input.optString("model").ifBlank { null }, input.optString("aspectRatio").ifBlank { null },
            input.optString("imageSize").ifBlank { null }, images)
        try {
            val result = generate(r, object : GenerateListener {
                override fun onStatus(message: String) = send(JSONObject().put("type", "status").put("message", message))
                override fun onText(text: String) = send(JSONObject().put("type", "text").put("text", text))
            })
            val b64 = result.base64
            send(JSONObject().put("type", "image_start").put("mimeType", result.mimeType).put("bytes", b64.length.toLong() * 3 / 4))
            var i = 0
            while (i < b64.length) { send(JSONObject().put("type", "image_chunk").put("data", b64.substring(i, minOf(b64.length, i + CHUNK)))); i += CHUNK }
            send(JSONObject().put("type", "image_end"))
            send(JSONObject().put("type", "done").put("model", result.model).put("finishReason", result.finishReason ?: JSONObject.NULL)
                .put("usage", result.usage ?: JSONObject.NULL))
        } catch (e: Exception) {
            try { send(JSONObject().put("type", "error").put("message", e.message ?: e.toString())) } catch (_: Exception) { }
        }
    }

    private fun respond(out: OutputStream, code: Int, type: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = mapOf(200 to "OK", 403 to "Forbidden", 404 to "Not Found")[code] ?: "OK"
        out.write("HTTP/1.1 $code $reason\r\nContent-Type: $type\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }

    companion object { const val CHUNK = 64 * 1024 }
}

/** pid without java.lang.ProcessHandle (missing on older Android). */
object ProcessHandleCompat {
    fun pid(): Long = try {
        val cls = Class.forName("android.os.Process")
        (cls.getMethod("myPid").invoke(null) as Int).toLong()
    } catch (e: Exception) {
        try { java.lang.management.ManagementFactory.getRuntimeMXBean().name.substringBefore('@').toLong() } catch (e2: Throwable) { 0L }
    }
}
