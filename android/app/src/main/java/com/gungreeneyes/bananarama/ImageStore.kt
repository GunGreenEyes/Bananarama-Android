package com.gungreeneyes.bananarama

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import com.gungreeneyes.bananarama.core.Naming
import com.gungreeneyes.bananarama.core.RefImage
import java.io.ByteArrayOutputStream
import java.io.File

/** Saves images to Pictures/<subfolder> through MediaStore, so they appear in the Gallery. */
object ImageStore {
    class Saved(val uri: Uri, val name: String, val mimeType: String)
    class Item(val uri: Uri, val name: String, val dateAdded: Long)

    fun save(context: Context, bytes: ByteArray, mimeType: String, prompt: String, subfolder: String, prefix: String = "image"): Saved {
        val ext = Naming.extensionFor(bytes, mimeType)
        val mime = Naming.mimeFor(ext)
        val name = Naming.fileName(prefix, prompt, ext = ext)
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
        }
        val collection: Uri
        if (Build.VERSION.SDK_INT >= 29) {
            collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            values.put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$subfolder")
            values.put(MediaStore.Images.Media.IS_PENDING, 1)
        } else {
            collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), subfolder).apply { mkdirs() }
            @Suppress("DEPRECATION")
            values.put(MediaStore.Images.Media.DATA, File(dir, name).absolutePath)
        }
        val uri = resolver.insert(collection, values) ?: throw IllegalStateException("could not create the image in Pictures/$subfolder")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("could not write the image")
            if (Build.VERSION.SDK_INT >= 29) {
                resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            }
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return Saved(uri, name, mime)
    }

    /** Newest images in Pictures/<subfolder>. */
    fun recent(context: Context, subfolder: String, limit: Int = 24): List<Item> {
        val out = mutableListOf<Item>()
        val collection = if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        @Suppress("DEPRECATION")
        val (selection, arg) = if (Build.VERSION.SDK_INT >= 29)
            "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?" to "${Environment.DIRECTORY_PICTURES}/$subfolder/%"
        else "${MediaStore.Images.Media.DATA} LIKE ?" to "%/${Environment.DIRECTORY_PICTURES}/$subfolder/%"
        try {
            context.contentResolver.query(collection,
                arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED),
                selection, arrayOf(arg), "${MediaStore.Images.Media.DATE_ADDED} DESC")?.use { c ->
                while (c.moveToNext() && out.size < limit) {
                    out += Item(ContentUris.withAppendedId(collection, c.getLong(0)), c.getString(1) ?: "", c.getLong(2))
                }
            }
        } catch (e: SecurityException) { /* Android 8-9 without storage permission: nothing to show */ }
        return out
    }

    /** Small JPEG as a data: URL for the UI. */
    fun thumbnail(context: Context, uri: Uri, size: Int = 320): String? = try {
        val bmp: Bitmap? = if (Build.VERSION.SDK_INT >= 29) context.contentResolver.loadThumbnail(uri, Size(size, size), null)
        else context.contentResolver.openInputStream(uri)?.use { input ->
            val bytes = input.readBytes()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            var sample = 1
            while (bounds.outWidth / sample > size * 2) sample *= 2
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
        bmp?.let {
            val out = ByteArrayOutputStream()
            it.compress(Bitmap.CompressFormat.JPEG, 80, out)
            "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    } catch (e: Exception) { null }

    /** Read an image the user picked or shared, as a reference for Gemini (re-encoded if huge). */
    fun readReference(context: Context, uri: Uri): RefImage {
        val resolver = context.contentResolver
        var bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw IllegalStateException("could not read the image")
        var mime = resolver.getType(uri) ?: "image/jpeg"
        if (bytes.size > 7 * 1024 * 1024 || mime !in listOf("image/png", "image/jpeg", "image/webp", "image/heic", "image/heif")) {
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IllegalStateException("unsupported image")
            val scale = minOf(1f, 2048f / maxOf(bmp.width, bmp.height))
            val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 90, out)
            bytes = out.toByteArray(); mime = "image/jpeg"
        }
        return RefImage(mime, java.util.Base64.getEncoder().encodeToString(bytes))
    }
}
