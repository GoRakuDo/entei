package org.gorakudo.entei.modules.ankidroid

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.util.Base64
import androidx.core.content.FileProvider
import com.ichi2.anki.FlashCardsContract
import com.ichi2.anki.api.AddContentApi
import java.io.File

/**
 * Media handoff to AnkiDroid under Android 11+ scoped storage.
 *
 * A screenshot or a mined audio clip is a private cache file, and AnkiDroid is a
 * different app — it can neither read our cache path nor is it allowed to. The
 * only sanctioned route is the one `FlashCardsContract.AnkiMedia` documents:
 * publish the bytes as a `content://` URI through our FileProvider, grant
 * AnkiDroid a one-shot read on it, insert the row, then drop the grant. The
 * insertion answers with the file name AnkiDroid finally stored (it may rename
 * or de-duplicate), and that name is what the caller must embed in card markup.
 *
 * AnkiDroid derives the media extension from the URI's MIME type, so the
 * temporary file keeps the caller's extension — a `.webm` clip must not be
 * handed over as an extension-less blob.
 */
class MediaApi(private val context: Context) {

    /**
     * AnkiConnect `storeMediaFile`: store [base64Data] and return the filename
     * AnkiDroid actually wrote.
     *
     * The markup itself (`[sound:...]`, `<img src="...">`) is built by the web
     * layer from this returned name — never here — so AnkiDroid's rename or
     * content-hash de-duplication can never leave a dangling reference.
     */
    fun storeMediaFile(filename: String, base64Data: String): String {
        val bytes = decode(base64Data, filename)
        if (bytes.isEmpty()) throw Exception("Media payload is empty: $filename")

        val mediaDir = File(context.cacheDir, MEDIA_DIR_NAME).apply { mkdirs() }
        val extension = extensionOf(filename)
        val suffix = if (extension.isEmpty()) "" else ".$extension"
        val tempFile = File(mediaDir, "entei_media_${System.nanoTime()}$suffix")
        tempFile.writeBytes(bytes)

        val fileUri = FileProvider.getUriForFile(context, fileProviderAuthority(), tempFile)
        try {
            context.grantUriPermission(
                ankiDroidPackage(),
                fileUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )

            val values = ContentValues().apply {
                put(FlashCardsContract.AnkiMedia.FILE_URI, fileUri.toString())
                put(FlashCardsContract.AnkiMedia.PREFERRED_NAME, preferredNameOf(filename))
            }
            val insertedUri = context.contentResolver.insert(
                FlashCardsContract.AnkiMedia.CONTENT_URI,
                values,
            ) ?: throw Exception("AnkiDroid rejected the media file: $filename")

            return storedNameOf(insertedUri.path)
        } finally {
            // AnkiDroid has copied the bytes by now (or failed): the temp file and
            // the read grant are pure leak surface from here on.
            tempFile.delete()
            context.revokeUriPermission(
                ankiDroidPackage(),
                fileUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        }
    }

    /** Decode AnkiConnect's base64 payload, tolerating a full `data:` URL. */
    private fun decode(base64Data: String, filename: String): ByteArray {
        val payload = if (base64Data.startsWith("data:")) {
            base64Data.substringAfter(',', base64Data)
        } else {
            base64Data
        }
        return try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (error: IllegalArgumentException) {
            throw Exception("Media payload for $filename is not valid base64: ${error.message}")
        }
    }

    /**
     * The stem AnkiDroid works from: no extension (it appends the MIME-derived
     * one itself), no spaces or punctuation, and never shorter than three
     * characters — a one- or two-character stem is too easy to collide with.
     */
    private fun preferredNameOf(filename: String): String {
        val stem = filename.substringBeforeLast('.', filename)
            .replace(UNSAFE_NAME_CHARS, "_")
        return if (stem.length < MIN_PREFERRED_NAME_LENGTH) DEFAULT_PREFERRED_NAME else stem
    }

    /** Caller's extension, restricted to letters/digits so it stays a safe suffix. */
    private fun extensionOf(filename: String): String {
        val extension = filename.substringAfterLast('.', "")
        return if (extension.isNotEmpty() && extension.all { it.isLetterOrDigit() }) extension else ""
    }

    /**
     * Basename AnkiDroid reported. Only `[A-Za-z0-9._-]` survives, so the value
     * cannot escape into path traversal or inject markup into a card field.
     */
    private fun storedNameOf(path: String?): String {
        val name = File(path ?: "").name
        val usable = name.isNotEmpty() &&
            name.all { it.isLetterOrDigit() || it in ALLOWED_STORED_CHARS }
        if (!usable) throw Exception("AnkiDroid returned an unusable media name: $name")
        return name
    }

    /** `com.ichi2.anki`, or the variant that actually resolved the provider. */
    private fun ankiDroidPackage(): String =
        AddContentApi.getAnkiDroidPackageName(context) ?: ANKIDROID_PACKAGE

    /** Must match the `android:authorities` in the module's AndroidManifest. */
    private fun fileProviderAuthority(): String = "${context.packageName}.anki.fileprovider"

    private companion object {
        const val MEDIA_DIR_NAME = "anki_media"

        /** Used when the caller's filename has no usable stem. */
        const val DEFAULT_PREFERRED_NAME = "entei_media"

        const val MIN_PREFERRED_NAME_LENGTH = 3

        /** AnkiDroid's own package name. */
        const val ANKIDROID_PACKAGE = "com.ichi2.anki"

        /** Characters that may appear in the name AnkiDroid hands back. */
        val UNSAFE_NAME_CHARS = Regex("[^A-Za-z0-9_-]")

        val ALLOWED_STORED_CHARS = charArrayOf('.', '_', '-')
    }
}
