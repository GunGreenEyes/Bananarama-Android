package com.gungreeneyes.bananarama.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.Calendar

// 1x1 transparent PNG
const val PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

fun sse(vararg events: JSONObject, crlf: Boolean = false): String {
    val nl = if (crlf) "\r\n" else "\n"
    return events.joinToString("") { "data: $it$nl$nl" }
}

fun imageEvent(b64: String = PNG_B64, mime: String = "image/png") = JSONObject(
    """{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"$mime","data":"$b64"}}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":42}}"""
)

class InlineAndNamingTest {
    @Test fun inlineOptions() {
        assertEquals(ImageRequest("a fox in a library", "pro", "16:9", "2K"), Inline.parse("a fox in a library, 16:9, 2k, pro"))
        assertEquals(ImageRequest("red, green and blue"), Inline.parse("red, green and blue"))
        assertEquals(ImageRequest("poster", aspectRatio = "9:16"), Inline.parse("  9:16 , poster "))
    }

    @Test fun modelAliases() {
        assertEquals("gemini-3-pro-image", Models.resolve("pro"))
        assertEquals("gemini-3.1-flash-lite-image", Models.resolve("LITE"))
        assertEquals("gemini-2.5-flash-image", Models.resolve("gemini-2.5-flash-image"))
        assertNull(Models.resolve(" "))
        assertFalse(Models.supportsSize("gemini-2.5-flash-image"))
    }

    @Test fun fileNames() {
        val now = Calendar.getInstance().apply { set(2026, 10, 18, 9, 5, 7) }.time
        assertEquals("image_20261118-090507_a-cat-in-space.png", Naming.fileName("image", "A Cat, in SPACE!!", now))
        assertEquals("image_20261118-090507_image.jpg", Naming.fileName("image", "!!!", now, ".jpg"))
        assertTrue(Naming.fileName("p", "x".repeat(200), now).length < 80)
    }

    @Test fun extensions() {
        val png = Base64.getDecoder().decode(PNG_B64)
        assertEquals(".png", Naming.extensionFor(png, "image/jpeg"))
        assertEquals(".jpg", Naming.extensionFor(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0), "image/png"))
        assertEquals(".webp", Naming.extensionFor("RIFF".toByteArray(), "image/webp"))
        assertEquals("image/jpeg", Naming.mimeFor(".jpg"))
    }
}

class SseTest {
    @Test fun lfCrlfAndTail() {
        val out = mutableListOf<String>()
        Sse.read(ByteArrayInputStream("data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\n\ndata: {\"c\":3}".toByteArray())) { out += it }
        assertEquals(listOf("{\"a\":1}", "{\"b\":2}", "{\"c\":3}"), out)
    }

    @Test fun multiLineData() {
        val out = mutableListOf<String>()
        Sse.read(ByteArrayInputStream("event: x\ndata: line1\ndata: line2\n\n".toByteArray())) { out += it }
        assertEquals(listOf("line1\nline2"), out)
    }
}

class GeminiTest {
    private lateinit var server: MockWebServer

    @Before fun up() { server = MockWebServer(); server.start() }
    @After fun down() { server.shutdown() }

    private fun gemini(key: String = "test-key", model: String = Models.DEFAULT) =
        Gemini(Defaults(apiKey = key, model = model, apiBase = server.url("/v1beta").toString()))

    @Test fun streamsImageSkippingThoughtsAndSendsTheRightRequest() {
        val thought = JSONObject("""{"candidates":[{"content":{"parts":[{"thought":true,"inlineData":{"mimeType":"image/png","data":"AAAA"}}]}}]}""")
        val text = JSONObject("""{"candidates":[{"content":{"parts":[{"text":"Here you go."}]}}]}""")
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(sse(thought, text, imageEvent(), crlf = true)))
        val texts = mutableListOf<String>()
        val r = gemini().generate(ImageRequest("a banana", aspectRatio = "16:9", imageSize = "4k", model = "pro"),
            object : GenerateListener { override fun onText(text: String) { texts += text } })
        assertArrayEquals(Base64.getDecoder().decode(PNG_B64), r.bytes)
        assertEquals("image/png", r.mimeType)
        assertEquals(listOf("Here you go."), texts)
        assertEquals("STOP", r.finishReason)
        assertEquals(42, r.usage!!.getInt("totalTokenCount"))

        val req = server.takeRequest()
        assertEquals("/v1beta/models/gemini-3-pro-image:streamGenerateContent?alt=sse", req.path)
        assertEquals("test-key", req.getHeader("x-goog-api-key"))
        val body = JSONObject(req.body.readUtf8())
        val cfg = body.getJSONObject("generationConfig")
        assertEquals("16:9", cfg.getJSONObject("imageConfig").getString("aspectRatio"))
        assertEquals("4K", cfg.getJSONObject("imageConfig").getString("imageSize"))
        assertEquals("[\"TEXT\",\"IMAGE\"]", cfg.getJSONArray("responseModalities").toString())
        assertEquals("a banana", body.getJSONArray("contents").getJSONObject(0).getJSONArray("parts").getJSONObject(0).getString("text"))
    }

    @Test fun defaultsAndNoSizeFor25AndReferenceImages() {
        server.enqueue(MockResponse().setBody(sse(imageEvent())))
        gemini().generate(ImageRequest("old", model = "original", images = listOf(RefImage("image/png", PNG_B64))))
        val body = JSONObject(server.takeRequest().body.readUtf8())
        val ic = body.getJSONObject("generationConfig").getJSONObject("imageConfig")
        assertEquals("1:1", ic.getString("aspectRatio"))
        assertFalse(ic.has("imageSize"))
        val ref = body.getJSONArray("contents").getJSONObject(0).getJSONArray("parts").getJSONObject(1).getJSONObject("inlineData")
        assertEquals(PNG_B64, ref.getString("data"))
    }

    @Test fun httpErrorsAreReadable() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":{"code":400,"message":"API key not valid."}}"""))
        try { gemini().generate(ImageRequest("x")); fail() } catch (e: GeminiException) { assertEquals("Gemini HTTP 400: API key not valid.", e.message) }
    }

    @Test fun noImageAndBlocked() {
        server.enqueue(MockResponse().setBody(sse(JSONObject("""{"candidates":[{"finishReason":"IMAGE_SAFETY"}]}"""))))
        try { gemini().generate(ImageRequest("x")); fail() } catch (e: GeminiException) { assertEquals("no image returned (finishReason: IMAGE_SAFETY)", e.message) }
        server.enqueue(MockResponse().setBody(sse(JSONObject("""{"promptFeedback":{"blockReason":"SAFETY"}}"""))))
        try { gemini().generate(ImageRequest("x")); fail() } catch (e: GeminiException) { assertEquals("prompt blocked: SAFETY", e.message) }
    }

    @Test fun missingKeyAndPromptFailFast() {
        try { gemini(key = "").generate(ImageRequest("x")); fail() } catch (e: GeminiException) { assertTrue(e.message!!.contains("no API key")) }
        try { gemini().generate(ImageRequest(" ")); fail() } catch (e: GeminiException) { assertEquals("a description is required", e.message) }
        assertEquals(0, server.requestCount)
    }

    @Test fun keyCheck() {
        val models = """{"models":[{"name":"models/gemini-3.1-flash-image"}]}"""
        server.enqueue(MockResponse().setBody(models))
        assertTrue(gemini().checkKey() is Gemini.KeyCheck.Ok)
        server.enqueue(MockResponse().setBody(models))
        assertTrue(gemini(model = "gemini-3-pro-image").checkKey() is Gemini.KeyCheck.ModelMissing)
        server.enqueue(MockResponse().setResponseCode(400))
        assertTrue(gemini().checkKey() is Gemini.KeyCheck.Invalid)
        assertTrue(gemini(key = "").checkKey() is Gemini.KeyCheck.Invalid)
        assertEquals("good", server.takeRequest().let { "good" })
    }
}

class LocalApiTest {
    private lateinit var gem: MockWebServer
    private lateinit var api: LocalApi

    @Before fun up() {
        gem = MockWebServer(); gem.start()
        val g = Gemini(Defaults(apiKey = "k", apiBase = gem.url("/v1beta").toString()))
        api = LocalApi(0, "2.0.0") { req, l -> g.generate(req, l) }
        api.start()
    }
    @After fun down() { api.stop(); gem.shutdown() }

    private fun call(method: String, path: String, body: String? = null, headers: Map<String, String> = emptyMap()): Pair<Int, String> {
        val c = URL("http://127.0.0.1:${api.boundPort}$path").openConnection() as HttpURLConnection
        c.requestMethod = method
        headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        c.disconnect()
        return code to text
    }

    @Test fun healthSpeaksTheWindowsProtocol() {
        val (code, body) = call("GET", "/health")
        assertEquals(200, code)
        val j = JSONObject(body)
        assertEquals("Bananarama", j.getString("name"))
        assertEquals(true, j.getBoolean("ok"))
        assertEquals("android", j.getString("platform"))
    }

    @Test fun imagineStreamsNdjsonThatReassemblesToTheImage() {
        gem.enqueue(MockResponse().setBody(sse(JSONObject("""{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}"""), imageEvent())))
        val (code, body) = call("POST", "/imagine", """{"prompt":"a cat","aspectRatio":"9:16"}""")
        assertEquals(200, code)
        val events = body.trim().lines().map { JSONObject(it) }
        assertEquals(listOf("status", "text", "image_start", "image_chunk", "image_end", "done"), events.map { it.getString("type") })
        val data = events.filter { it.getString("type") == "image_chunk" }.joinToString("") { it.getString("data") }
        assertEquals(PNG_B64, data)
        assertEquals("9:16", JSONObject(gem.takeRequest().body.readUtf8()).getJSONObject("generationConfig").getJSONObject("imageConfig").getString("aspectRatio"))
    }

    @Test fun imagineErrors() {
        assertEquals("prompt is required", JSONObject(call("POST", "/imagine", "{}").second.trim()).getString("message"))
        gem.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":{"message":"quota"}}"""))
        assertEquals("Gemini HTTP 429: quota", JSONObject(call("POST", "/imagine", """{"prompt":"x"}""").second.trim().lines().last()).getString("message"))
    }

    @Test fun browserRequestsAreRefused() {
        // HttpURLConnection won't send custom Host/Origin headers, so use raw sockets
        fun status(headers: String) = java.net.Socket("127.0.0.1", api.boundPort).use { s ->
            s.getOutputStream().write("GET /health HTTP/1.1\r\n$headers\r\n".toByteArray())
            s.getInputStream().bufferedReader().readLine()
        }
        assertTrue(status("Host: 127.0.0.1\r\n").startsWith("HTTP/1.1 200"))
        assertTrue(status("Host: 127.0.0.1\r\nOrigin: https://evil.example\r\n").startsWith("HTTP/1.1 403"))  // cross-site page
        assertTrue(status("Host: evil.example:7861\r\n").startsWith("HTTP/1.1 403"))                          // DNS rebinding
        assertEquals(404, call("GET", "/nope").first)
        assertTrue(api.allowed(mapOf("host" to "localhost:7861")))
        assertFalse(api.allowed(mapOf("host" to "127.0.0.1:7861", "origin" to "null")))
    }
}
