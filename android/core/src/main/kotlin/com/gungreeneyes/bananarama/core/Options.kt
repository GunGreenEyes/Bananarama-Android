package com.gungreeneyes.bananarama.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** A reference image sent along with the prompt (to edit it or use it as a style). */
class RefImage(val mimeType: String, val base64: String)

/** One image request. Null fields fall back to [Defaults]. */
data class ImageRequest(
    val prompt: String,
    val model: String? = null,
    val aspectRatio: String? = null,
    val imageSize: String? = null,
    val images: List<RefImage> = emptyList()
)

/** The user's settings that matter to a request. */
data class Defaults(
    val apiKey: String,
    val model: String = Models.DEFAULT,
    val aspectRatio: String = "1:1",
    val imageSize: String = "1K",
    val apiBase: String = "https://generativelanguage.googleapis.com/v1beta",
    val timeoutMs: Int = 180_000
)

object Models {
    const val DEFAULT = "gemini-3.1-flash-image"
    val ALL = listOf("gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image")
    val ALIASES = mapOf(
        "pro" to "gemini-3-pro-image", "flash" to "gemini-3.1-flash-image", "2" to "gemini-3.1-flash-image",
        "lite" to "gemini-3.1-flash-lite-image", "original" to "gemini-2.5-flash-image", "2.5" to "gemini-2.5-flash-image"
    )
    val RATIOS = listOf("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
    val SIZES = listOf("1K", "2K", "4K")

    /** Alias or id -> model id; null/blank stays null. */
    fun resolve(m: String?): String? = m?.trim()?.takeIf { it.isNotEmpty() }?.let { ALIASES[it.lowercase()] ?: it }

    /** gemini-2.5-flash-image has no size option. */
    fun supportsSize(model: String) = !model.contains("2.5")
}

object Inline {
    /**
     * Pull options written inline ("a fox, 16:9, 2K, pro") out of a description, the same way
     * the /image skill and the Windows app do.
     */
    fun parse(text: String): ImageRequest {
        var ratio: String? = null
        var size: String? = null
        var model: String? = null
        val keep = mutableListOf<String>()
        for (raw in text.split(',')) {
            val t = raw.trim()
            val low = t.lowercase()
            when {
                ratio == null && low in Models.RATIOS -> ratio = low
                size == null && low in listOf("1k", "2k", "4k") -> size = low.uppercase()
                model == null && low in listOf("pro", "lite", "flash", "original") -> model = low
                t.isNotEmpty() -> keep += t
            }
        }
        return ImageRequest(keep.joinToString(", "), model, ratio, size)
    }
}

object Naming {
    private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

    fun isPng(b: ByteArray) = b.size >= 8 && (0 until 8).all { b[it] == PNG[it] }

    /** Extension for the bytes we got: trust the signature, else the mime type. */
    fun extensionFor(b: ByteArray, mimeType: String?): String {
        if (isPng(b)) return ".png"
        if (b.size >= 3 && b[0] == 0xff.toByte() && b[1] == 0xd8.toByte() && b[2] == 0xff.toByte()) return ".jpg"
        return when (mimeType?.lowercase()) {
            "image/jpeg" -> ".jpg"; "image/webp" -> ".webp"; "image/gif" -> ".gif"; "image/heic" -> ".heic"
            else -> ".png"
        }
    }

    fun mimeFor(ext: String) = when (ext) {
        ".jpg" -> "image/jpeg"; ".webp" -> "image/webp"; ".gif" -> "image/gif"; ".heic" -> "image/heic"; else -> "image/png"
    }

    fun slug(prompt: String): String {
        val s = prompt.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(40).trimEnd('-')
        return s.ifEmpty { "image" }
    }

    /** image_20261118-090507_a-cat-in-space.png - same scheme as the Windows app. */
    fun fileName(prefix: String, prompt: String, now: Date = Date(), ext: String = ".png"): String {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(now)
        return "${prefix}_${stamp}_${slug(prompt)}$ext"
    }
}
