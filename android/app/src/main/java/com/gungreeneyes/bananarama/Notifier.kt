package com.gungreeneyes.bananarama

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build

object Notifier {
    const val CH_JOBS = "jobs"
    const val CH_RESULTS = "results"
    const val CH_API = "api"
    const val ID_JOB = 1
    const val ID_API = 2
    private var nextId = 100

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel(CH_JOBS, context.getString(R.string.channel_jobs), NotificationManager.IMPORTANCE_LOW),
            NotificationChannel(CH_RESULTS, context.getString(R.string.channel_results), NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel(CH_API, context.getString(R.string.channel_api), NotificationManager.IMPORTANCE_MIN)
        ))
    }

    private fun builder(context: Context, channel: String) = Notification.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_banana)
        .setColor(0xFFF5C518.toInt())

    private fun pending(context: Context, code: Int, intent: Intent, activity: Boolean = true): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (activity) PendingIntent.getActivity(context, code, intent, flags) else PendingIntent.getService(context, code, intent, flags)
    }

    fun appIntent(context: Context, action: String? = null, uri: Uri? = null) = Intent(context, MainActivity::class.java).apply {
        this.action = action ?: Intent.ACTION_MAIN
        if (uri != null) { data = uri; addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun viewIntent(uri: Uri, mime: String) = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun shareIntent(context: Context, uri: Uri, mime: String): Intent = Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }, context.getString(R.string.share_image)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** The foreground-service notification while an image is being made. */
    fun progress(context: Context, text: String, detail: String? = null): Notification = builder(context, CH_JOBS)
        .setContentTitle(context.getString(R.string.making_image))
        .setContentText(if (detail != null) "$text · $detail" else text)
        .setProgress(0, 0, true)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(pending(context, 1, appIntent(context)))
        .build()

    fun done(context: Context, saved: ImageStore.Saved, bytes: ByteArray) {
        val picture: Bitmap? = try {
            val o = BitmapFactory.Options().apply { inSampleSize = 2 }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        } catch (e: Throwable) { null }
        val id = nextId++
        val b = builder(context, CH_RESULTS)
            .setContentTitle(context.getString(R.string.image_saved))
            .setContentText(saved.name)
            .setAutoCancel(true)
            .setContentIntent(pending(context, id * 10, viewIntent(saved.uri, saved.mimeType)))
            .addAction(Notification.Action.Builder(null, context.getString(R.string.action_share), pending(context, id * 10 + 1, shareIntent(context, saved.uri, saved.mimeType))).build())
            .addAction(Notification.Action.Builder(null, context.getString(R.string.action_edit), pending(context, id * 10 + 2, appIntent(context, MainActivity.ACTION_EDIT, saved.uri))).build())
            .addAction(Notification.Action.Builder(null, context.getString(R.string.action_new), pending(context, id * 10 + 3, appIntent(context, MainActivity.ACTION_NEW))).build())
        if (picture != null) b.setLargeIcon(picture).setStyle(Notification.BigPictureStyle().bigPicture(picture).bigLargeIcon(null as Bitmap?))
        notify(context, id, b.build())
    }

    fun failed(context: Context, message: String) {
        val keyProblem = Regex("API key|HTTP 40[013]", RegexOption.IGNORE_CASE).containsMatchIn(message)
        val b = builder(context, CH_RESULTS)
            .setContentTitle(context.getString(R.string.image_failed))
            .setContentText(message)
            .setStyle(Notification.BigTextStyle().bigText(message))
            .setAutoCancel(true)
            .setContentIntent(pending(context, 3, appIntent(context, if (keyProblem) MainActivity.ACTION_SETTINGS else MainActivity.ACTION_NEW)))
        notify(context, nextId++, b.build())
    }

    fun api(context: Context, port: Int): Notification = builder(context, CH_API)
        .setContentTitle(context.getString(R.string.api_title))
        .setContentText(context.getString(R.string.api_text, port))
        .setOngoing(true)
        .setContentIntent(pending(context, 4, appIntent(context, MainActivity.ACTION_SETTINGS)))
        .addAction(Notification.Action.Builder(null, context.getString(R.string.action_stop),
            pending(context, 5, Intent(context, ApiService::class.java).setAction(ApiService.ACTION_STOP), activity = false)).build())
        .build()

    private fun notify(context: Context, id: Int, n: Notification) {
        if (Build.VERSION.SDK_INT >= 33 && !Permissions.notificationsAllowed(context)) return
        context.getSystemService(NotificationManager::class.java).notify(id, n)
    }
}
