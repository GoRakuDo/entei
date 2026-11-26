package org.gorakudo.entei.modules.ankidroid

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.ichi2.anki.FlashCardsContract
import com.ichi2.anki.api.AddContentApi
import org.json.JSONObject

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
 * Phase 1 opens the transport: `version` answers, everything else is rejected
 * inside the envelope until the action implementations arrive. Failing inside
 * the envelope (instead of `invoke.reject`) is deliberate — a rejected Tauri
 * invoke surfaces as a command error, while an envelope keeps the shape the
 * TypeScript Anki clients already branch on.
 */
@TauriPlugin
class AnkiDroidModule(private val activity: Activity) : Plugin(activity) {

    private val context: Context
        get() = activity.applicationContext

    /**
     * Run one AnkiConnect-compatible action.
     *
     * Args: `action: String`, `version: Int?`, `params: JSONObject?`, `key: String?`
     * (the API key is unused on Android — AnkiDroid authorises through the
     * manifest permission, never a bearer token).
     */
    @Command
    fun ankidroid_request(invoke: Invoke) {
        val action = invoke.getArgs().optString("action", "")
        invoke.resolve(
            try {
                when (action) {
                    "version" -> successEnvelope(API_VERSION)
                    else -> errorEnvelope("Unsupported action on Android: $action")
                }
            } catch (error: Throwable) {
                // A ContentProvider failure must not tear the plugin down; the
                // caller reports it as an Anki export error either way.
                errorEnvelope(error.message ?: error.toString())
            }
        )
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
        val status = newStatus()
        try {
            // Provider visibility first: on a device without AnkiDroid this is
            // the only call that answers without throwing.
            if (AddContentApi.getAnkiDroidPackageName(context) == null) {
                status.put("state", "unavailable")
                status.put("message", ANKIDROID_MISSING_MESSAGE)
                status.put("errorKind", "network")
                invoke.resolve(status)
                return
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
        invoke.resolve(status)
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

    private fun successEnvelope(result: Any?): JSObject = JSObject().apply {
        put("result", result)
        put("error", JSONObject.NULL)
    }

    private fun errorEnvelope(message: String): JSObject = JSObject().apply {
        put("result", JSONObject.NULL)
        put("error", message)
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
    }
}
