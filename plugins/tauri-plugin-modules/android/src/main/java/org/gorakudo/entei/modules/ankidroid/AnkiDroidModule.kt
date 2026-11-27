package org.gorakudo.entei.modules.ankidroid

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.ichi2.anki.FlashCardsContract
import com.ichi2.anki.api.AddContentApi
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The Android half of Entei's Anki integration, reached through
 * `plugin:modules|modules_ankidroid_request`.
 *
 * The web layer keeps speaking the AnkiConnect wire protocol
 * (`{ action, version, params, key }` in, `{ result, error }` out); only the
 * transport changes. This module answers that protocol straight out of
 * AnkiDroid's own ContentProvider, in-process — no HTTP server on the phone and
 * no second APK.
 *
 * This class is the wire boundary and nothing else: it decodes the request,
 * routes the action to [DeckApi] / [ModelApi] / [NoteApi] / [CardApi] /
 * [MediaApi], and re-encodes the answer into the envelope. The action table
 * follows §5 of ANKIDROID_MODULE_ARCHITECTURE.md.
 *
 * Failures are answered *inside* the envelope (`{ result: null, error: "..." }`)
 * instead of `invoke.reject`: a rejected Tauri invoke surfaces as a command
 * error, while an envelope keeps the shape the TypeScript Anki clients already
 * branch on (`AnkiExportError` with a real message).
 *
 * Both commands run their provider work on [work], never on the thread Tauri
 * called them on: `runCommand` arrives on the Android UI thread
 * (`run_on_android_context`), and a hundred-note `cardsInfo`, a base64 media
 * decode or a media file write would hold that thread long enough to ANR the
 * app. The answer is sent from the worker: an invoke response travels through
 * JNI into a channel the Rust command awaits, so it has no UI thread of its own.
 */
@TauriPlugin
class AnkiDroidModule(private val activity: Activity) : Plugin(activity) {

    private val context: Context
        get() = activity.applicationContext

    /**
     * The single background thread every command runs on.
     *
     * One thread, not a pool: the API objects are thin ContentResolver wrappers
     * created per request, and serialising requests keeps AnkiDroid's provider
     * from seeing two writers at once. It is a daemon thread so a stuck provider
     * call can never keep the process alive.
     */
    private var work: ExecutorService = newWorker()

    private fun newWorker(): ExecutorService =
        Executors.newSingleThreadExecutor { task ->
            Thread(task, WORKER_NAME).apply { isDaemon = true }
        }

    /**
     * Run one AnkiConnect-compatible action.
     *
     * Args: `action: String`, `version: Int?`, `params: JSONObject?`, `key: String?`
     * (the API key is unused on Android — AnkiDroid authorises through the
     * manifest permission, never a bearer token).
     */
    @Command
    fun ankidroid_request(invoke: Invoke) {
        // Decoding the args is a cheap JSON parse; everything after it is provider
        // work, so the request object crosses over to the worker instead.
        val args = invoke.getArgs()
        val action = args.optString("action", "")
        val params = args.getJSObject("params") ?: JSObject()

        val answered = submit {
            invoke.resolve(
                try {
                    successEnvelope(dispatch(action, params))
                } catch (error: Throwable) {
                    // A ContentProvider failure must not tear the plugin down; the
                    // caller reports it as an Anki export error either way.
                    errorEnvelope(error.message ?: error.toString())
                }
            )
        }
        if (!answered) invoke.resolve(errorEnvelope(SHUTTING_DOWN_MESSAGE))
    }

    /**
     * Hand [task] to the background thread.
     *
     * A worker that was shut down by [onDestroy] is replaced first: Tauri can
     * hand the same plugin instance to a recreated activity, and a permanently
     * dead worker would answer every later request with a shutdown error.
     *
     * @return false only when the worker refused the task, so the caller answers
     *   the invoke itself rather than leaving the webview's promise pending
     *   forever.
     */
    private fun submit(task: () -> Unit): Boolean {
        val worker = synchronized(this) {
            if (work.isShutdown) work = newWorker()
            work
        }
        return try {
            worker.execute(task)
            true
        } catch (error: RejectedExecutionException) {
            false
        }
    }

    /**
     * Stop accepting work when Tauri tears the plugin down.
     *
     * `shutdown` (not `shutdownNow`) lets a request that is already inside the
     * provider finish, so an in-flight note or media write is never cut in half.
     */
    override fun onDestroy(activity: AppCompatActivity) {
        work.shutdown()
        super.onDestroy(activity)
    }

    /**
     * Route one decoded action to its API object.
     *
     * The API objects are created per request (they are thin ContentResolver
     * wrappers) so that their per-request caches — the model list, the deck
     * list — can never leak a stale collection view into a later call.
     */
    private fun dispatch(action: String, params: JSObject): Any? {
        val decks = DeckApi(context)
        val models = ModelApi(context)
        val notes = NoteApi(context, decks, models)
        val cards = CardApi(context, decks, models, notes)
        val media = MediaApi(context)

        return when (action) {
            // The version Entei speaks. AnkiConnect and this module both answer 6,
            // so the clients' `version >= 6` checks pass unchanged on Android.
            "version" -> API_VERSION

            "requestPermission" -> mapOf(
                "permission" to if (hasReadWritePermission()) "granted" else "denied",
                "requireApiKey" to false,
            )

            // AnkiDroid detection is a SHAPE check on this reply: the web layer
            // treats "object without an `actions` array" as AnkiDroid mode. The
            // `actions` key is therefore deliberately absent — never add it.
            "apiReflect" -> mapOf("scopes" to listOf("actions"))

            "deckNames" -> decks.deckNames().toList()
            "deckNamesAndIds" -> decks.deckNamesAndIds()
            "modelNames" -> models.modelNames().toList()
            "modelNamesAndIds" -> models.modelNamesAndIds()
            "modelFieldNames" -> models.modelFieldNames(params.optString("modelName", ""))

            "canAddNotes" -> notes.canAddNotes(notesArgument(params))
            "findNotes" -> notes.findNotes(params.optString("query", ""))
            "notesInfo" -> cards.notesInfo(longList(params, "notes"))
            "cardsInfo" -> cards.cardsInfo(longList(params, "cards"))
            "findCards" -> cards.findCards(params.optString("query", ""))
            "suspend" -> cards.suspend(longList(params, "cards"))

            "addNote" -> addNote(notes, params)
            "updateNoteFields" -> updateNoteFields(notes, params)
            "addTags" -> {
                notes.addTags(longList(params, "notes"), params.optString("tags", ""))
                null
            }

            "storeMediaFile" -> media.storeMediaFile(
                params.optString("filename", ""),
                params.optString("data", ""),
            )

            else -> throw Exception("Unsupported action on Android: $action")
        }
    }

    /** `addNote`: `{ note: { modelName, deckName, fields, tags } }` -> new note id. */
    private fun addNote(notes: NoteApi, params: JSObject): Long {
        val note = params.optJSONObject("note")
            ?: throw Exception("addNote requires a note object")
        val fields = stringMapOf(note.optJSONObject("fields"))
        if (fields.isEmpty()) throw Exception("addNote requires note.fields")
        return notes.addNote(
            modelName = note.optString("modelName", ""),
            deckName = note.optString("deckName", ""),
            fields = fields,
            tags = stringListOf(note.optJSONArray("tags")),
        )
    }

    /** `updateNoteFields`: `{ note: { id, fields } }` -> `{ noteId }`. */
    private fun updateNoteFields(notes: NoteApi, params: JSObject): Map<String, Long> {
        val note = params.optJSONObject("note")
            ?: throw Exception("updateNoteFields requires a note object")
        val noteId = note.optLong("id", 0L)
        if (noteId <= 0L) throw Exception("updateNoteFields requires note.id")
        val updated = notes.updateNoteFields(noteId, stringMapOf(note.optJSONObject("fields")))
        if (!updated) throw Exception("Failed to update note $noteId")
        return mapOf("noteId" to noteId)
    }

    /**
     * Probe AnkiDroid in one call and answer the same
     * `AnkiNativeConnectionStatus` shape the desktop loopback plugin returns, so
     * the web layer validates both with a single guard.
     *
     * Every key is always present (explicit `JSONObject.NULL` for the empty
     * ones): the TypeScript validator rejects a status whose keys are missing.
     */
    @Command
    fun ankidroid_check_connection(invoke: Invoke) {
        val answered = submit { invoke.resolve(connectionStatus()) }
        if (!answered) invoke.resolve(newStatus())
    }

    /** Probe AnkiDroid and build the status the web layer validates. */
    private fun connectionStatus(): JSObject {
        val status = newStatus()
        try {
            // Provider visibility first: on a device without AnkiDroid this is
            // the only call that answers without throwing.
            if (AddContentApi.getAnkiDroidPackageName(context) == null) {
                status.put("state", "unavailable")
                status.put("message", ANKIDROID_MISSING_MESSAGE)
                status.put("errorKind", "network")
                return status
            }

            val api = AddContentApi(context)
            val specVersion = api.apiHostSpecVersion
            // AnkiConnect API version: always 6 to match desktop AnkiConnect
            status.put("version", API_VERSION)
            status.put("providerSpecVersion", specVersion)

            when {
                specVersion < REQUIRED_PROVIDER_SPEC_VERSION -> {
                    status.put("state", "unavailable")
                    status.put("message", ANKIDROID_OUTDATED_MESSAGE)
                    status.put("errorKind", "network")
                }

                !hasReadWritePermission() -> {
                    status.put("state", "permission-denied")
                    status.put("message", PERMISSION_MESSAGE)
                    status.put("errorKind", "permission-denied")
                }

                else -> {
                    status.put("state", "connected")
                    status.put("decks", namesOf(api.deckList?.values))
                    status.put("models", namesOf(api.getModelList(0)?.values))
                }
            }
        } catch (error: Throwable) {
            status.put("state", "unknown-error")
            status.put("message", error.message ?: error.toString())
            status.put("errorKind", "invalid-response")
        }
        return status
    }

    /** A fully populated status with the "nothing learned yet" values. */
    private fun newStatus() = JSObject().apply {
        put("state", "unknown-error")
        put("endpoint", CONTENT_ENDPOINT)
        put("version", JSONObject.NULL)
        put("requireApiKey", false)
        put("decks", JSArray())
        put("models", JSArray())
        put("message", JSONObject.NULL)
        put("errorKind", JSONObject.NULL)
    }

    /** AnkiConnect success envelope: `{ result, error: null }`. */
    private fun successEnvelope(result: Any?): JSObject = JSObject().apply {
        put("result", jsonValueOf(result))
        put("error", JSONObject.NULL)
    }

    /** AnkiConnect failure envelope: `{ result: null, error }`. */
    private fun errorEnvelope(message: String): JSObject = JSObject().apply {
        put("result", JSONObject.NULL)
        put("error", message)
    }

    /**
     * Recursively convert a Kotlin result (maps, lists, arrays, scalars) into
     * org.json values.
     *
     * The API objects return plain Kotlin collections; org.json would stringify a
     * `Map`/`List` handed to `put` as-is, so every nesting level has to be
     * converted before it reaches the envelope.
     */
    private fun jsonValueOf(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSObject().apply {
            value.forEach { (key, entryValue) -> put(key.toString(), jsonValueOf(entryValue)) }
        }
        is Iterable<*> -> JSArray(value.map { jsonValueOf(it) })
        is Array<*> -> JSArray(value.map { jsonValueOf(it) })
        is BooleanArray -> JSArray(value.toList().map { jsonValueOf(it) })
        is LongArray -> JSArray(value.toList().map { jsonValueOf(it) })
        else -> value
    }

    /** `params.notes` for `canAddNotes` (one decoded map per note). */
    private fun notesArgument(params: JSObject): List<Map<String, Any?>> {
        val array = params.optJSONArray("notes") ?: return emptyList()
        val notes = mutableListOf<Map<String, Any?>>()
        for (index in 0 until array.length()) {
            val note = array.optJSONObject(index) ?: continue
            notes.add(note.asMap())
        }
        return notes
    }

    /** `params.<key>` as a list of numeric ids (`notes`, `cards`). */
    private fun longList(params: JSObject, key: String): List<Long> {
        val array = params.optJSONArray(key) ?: return emptyList()
        return (0 until array.length()).map { array.optLong(it) }
    }

    /** `note.tags` as strings. */
    private fun stringListOf(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).map { array.optString(it, "") }
    }

    /** `note.fields` as `{ fieldName: value }`. */
    private fun stringMapOf(objects: JSONObject?): Map<String, String> {
        if (objects == null) return emptyMap()
        val fields = LinkedHashMap<String, String>(objects.length())
        val keys = objects.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            fields[key] = objects.optString(key, "")
        }
        return fields
    }

    /** A `string[]` for the status, from an id -> name map that may be absent. */
    private fun namesOf(names: Collection<String>?): JSArray =
        JSArray(names?.toList() ?: emptyList<String>())

    private fun hasReadWritePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, AddContentApi.READ_WRITE_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED

    private companion object {
        /** AnkiConnect API version this module speaks. */
        const val API_VERSION = 6

        /** Provider spec 2 (AnkiDroid 2.6+) — bulk insert and stable models. */
        const val REQUIRED_PROVIDER_SPEC_VERSION = 2

        /** What the desktop plugin reports as its endpoint, in Android terms. */
        val CONTENT_ENDPOINT = FlashCardsContract.AUTHORITY_URI.toString()

        const val ANKIDROID_MISSING_MESSAGE =
            "AnkiDroid is not installed. Install AnkiDroid to export cards on Android."

        const val ANKIDROID_OUTDATED_MESSAGE =
            "The installed AnkiDroid is too old. ContentProvider spec 2 or newer is required."

        const val PERMISSION_MESSAGE =
            "Entei does not have permission to access AnkiDroid. Grant database access to continue."

        /** Answered to a request that arrives after [onDestroy] stopped the worker. */
        const val SHUTTING_DOWN_MESSAGE =
            "The AnkiDroid module is shutting down. Reopen Entei and try again."

        /** Name of the worker thread, so it is identifiable in a thread dump. */
        const val WORKER_NAME = "entei-ankidroid"
    }
}

/**
 * Deep-copy an org.json object into Kotlin maps/lists.
 *
 * `canAddNotes` takes decoded `Map<String, Any?>` notes (its `options` block is
 * nested), so JSON has to leave the wire layer here rather than leak into
 * [NoteApi].
 */
private fun JSONObject.asMap(): Map<String, Any?> {
    val result = LinkedHashMap<String, Any?>(length())
    val keys = keys()
    while (keys.hasNext()) {
        val key = keys.next()
        val value = opt(key)
        result[key] = when {
            value is JSONObject -> value.asMap()
            JSONObject.NULL == value -> null
            else -> value
        }
    }
    return result
}
