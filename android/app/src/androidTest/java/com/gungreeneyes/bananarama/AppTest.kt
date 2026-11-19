package com.gungreeneyes.bananarama

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.gungreeneyes.bananarama.core.ImageRequest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/** Runs on an emulator in CI: the real services, MediaStore, WebView and intents, against a fake Gemini. */
@RunWith(AndroidJUnit4::class)
class AppTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var gem: MockWebServer
    private val created = mutableListOf<Uri>()

    private fun imageSse() = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"}]}}]}\n\n" +
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"$PNG_B64\"}}]},\"finishReason\":\"STOP\"}]}\n\n")

    @Before fun up() {
        gem = MockWebServer(); gem.start()
        Prefs(ctx).apply {
            apiKey = "test-key-for-the-emulator-0000"
            apiBase = gem.url("/v1beta").toString()
            setupDone = true
            subfolder = "NanoTest"
            confirmShares = true
        }
    }

    @After fun down() {
        created.forEach { try { ctx.contentResolver.delete(it, null, null) } catch (_: Exception) { } }
        gem.shutdown()
        Prefs(ctx).apply { apiBase = Prefs.DEFAULT_BASE; apiKey = ""; setupDone = false; subfolder = "Nano"; localApi = false }
    }

    @Test fun jobSavesTheImageToPictures() {
        gem.enqueue(imageSse())
        val saved = Jobs.run(ctx, "t1", ImageRequest("instrumented banana", aspectRatio = "16:9"))
        created += saved.uri
        val bytes = ctx.contentResolver.openInputStream(saved.uri)!!.use { it.readBytes() }
        assertArrayEquals(java.util.Base64.getDecoder().decode(PNG_B64), bytes)
        assertTrue(saved.name, saved.name.matches(Regex("image_\\d{8}-\\d{6}_instrumented-banana\\.png")))
        assertTrue(ImageStore.recent(ctx, "NanoTest").any { it.uri == saved.uri })
        val body = JSONObject(gem.takeRequest(5, TimeUnit.SECONDS)!!.body.readUtf8())
        assertEquals("16:9", body.getJSONObject("generationConfig").getJSONObject("imageConfig").getString("aspectRatio"))
    }

    @Test fun generateServiceFinishesInTheBackground() {
        gem.enqueue(imageSse())
        val done = CountDownLatch(1)
        var event: JSONObject? = null
        val listener = Jobs.Listener { ev -> if (ev.optString("id") == "svc1" && ev.optString("type") in listOf("done", "error")) { event = ev; done.countDown() } }
        Jobs.listen(listener)
        ActivityScenario.launch(MainActivity::class.java).use {
            ctx.startForegroundService(GenerateService.intent(ctx, "svc1", ImageRequest("service banana")))
            assertTrue("job finished", done.await(60, TimeUnit.SECONDS))
        }
        Jobs.unlisten(listener)
        assertEquals(event.toString(), "done", event!!.getString("type"))
        created += Uri.parse(event!!.getString("uri"))
    }

    @Test fun selectedTextOpensTheQuickScreenWithOptionsParsed() {
        val intent = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_PROCESS_TEXT).setType("text/plain")
            .putExtra(Intent.EXTRA_PROCESS_TEXT, "a test fox in a library, 16:9")
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            // wait for the quick screen (its close button), not the home screen shown while the page boots
            val got = pollJs(scenario, "document.querySelector('[data-act=back-to-app]') ? JSON.stringify([document.getElementById('prompt').value, document.getElementById('ratio').value]) : null")
            assertEquals("[\"a test fox in a library\",\"16:9\"]", got)
        }
    }

    @Test fun firstLaunchShowsTheSetupWizard() {
        Prefs(ctx).apply { apiKey = ""; setupDone = false }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            assertEquals("Make pictures from Claude", pollJs(scenario, "document.querySelector('h1') && document.querySelector('h1').textContent"))
        }
    }

    @Test fun claudeCodeLinkAnswersHealth() {
        Prefs(ctx).apply { port = 7871; localApi = true }
        ActivityScenario.launch(MainActivity::class.java).use {
            ctx.startForegroundService(Intent(ctx, ApiService::class.java))
            var body: String? = null
            for (i in 0 until 40) {
                body = try {
                    (URL("http://127.0.0.1:7871/health").openConnection() as HttpURLConnection).run {
                        connectTimeout = 500; readTimeout = 1000; inputStream.bufferedReader().readText()
                    }
                } catch (e: Exception) { null }
                if (body != null) break
                Thread.sleep(250)
            }
            assertNotNull("health answered", body)
            assertEquals("Bananarama", JSONObject(body!!).getString("name"))
            ctx.startService(Intent(ctx, ApiService::class.java).setAction(ApiService.ACTION_STOP))
        }
    }

    /** Evaluate JS in the page until it returns something that isn't null/empty (the page loads asynchronously). */
    private fun pollJs(scenario: ActivityScenario<MainActivity>, expr: String): String? {
        var result: String? = null
        for (i in 0 until 60) {
            val latch = CountDownLatch(1)
            scenario.onActivity { a -> a.web.evaluateJavascript("(function(){try{return $expr}catch(e){return null}})()") { v -> result = v; latch.countDown() } }
            latch.await(2, TimeUnit.SECONDS)
            val r = result
            // evaluateJavascript hands back the value JSON-encoded ("\"text\"" for a string)
            if (r != null && r != "null" && r != "\"\"" && r != "\"[null,null]\"") return JSONObject("{\"v\":$r}").get("v").toString()
            Thread.sleep(250)
        }
        return result
    }
}
