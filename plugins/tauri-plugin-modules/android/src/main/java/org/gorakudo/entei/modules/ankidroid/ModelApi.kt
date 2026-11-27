package org.gorakudo.entei.modules.ankidroid

import android.content.Context
import android.net.Uri
import com.ichi2.anki.FlashCardsContract
import com.ichi2.anki.api.AddContentApi

/**
 * Note type (model) reads: names, field definitions and note -> model resolution.
 *
 * Two AnkiDroid facts drive the shape of this class:
 *
 * - `AddContentApi.getModelList(minNumFields)` is the only bulk read, and the
 *   web layer asks for models and fields repeatedly within one action (a
 *   100-note `notesInfo`, a field-mapping refresh ...), so the list is fetched
 *   once per request and cached on the instance.
 * - `AddContentApi.getNote()` projects `{_id, flds, tags}` only — it does *not*
 *   carry `mid`, so the model of an existing note has to be read with a
 *   separate `Note.MID` query ([getNoteModelId]).
 */
class ModelApi(private val context: Context) {

    private val api = AddContentApi(context)

    /** `modelId -> modelName` for every model (`minNumFields = 0` keeps empty ones). */
    private val models: Map<Long, String> by lazy { api.getModelList(0) ?: emptyMap() }

    /** AnkiConnect `modelNames`. */
    fun modelNames(): Array<String> = models.values.toTypedArray()

    /** AnkiConnect `modelNamesAndIds`: `{ modelName: modelId }`. */
    fun modelNamesAndIds(): Map<String, Long> =
        models.entries.associate { it.value to it.key }

    /** AnkiConnect `modelFieldNames`: field names of [modelName], in model order. */
    fun modelFieldNames(modelName: String): Array<String> =
        modelFieldNamesById(getModelId(modelName))

    /** Field names of [modelId], in model order (the order `flds` is stored in). */
    fun modelFieldNamesById(modelId: Long): Array<String> =
        api.getFieldList(modelId) ?: emptyArray()

    /**
     * Resolve a note type name to its id.
     *
     * Fails loudly: adding into a mistyped model would otherwise land on a
     * different note type with different fields.
     */
    fun getModelId(modelName: String): Long =
        modelNamesAndIds()[modelName] ?: throw Exception("Model not found: $modelName")

    /**
     * Model name for [modelId].
     *
     * `"Default"` is the design-doc fallback for a model AnkiDroid no longer
     * lists (deleted or renamed mid-session): the caller only displays it, and an
     * empty string would blank out the append panel's note-type column.
     */
    fun getModelName(modelId: Long): String = models[modelId] ?: DEFAULT_MODEL_NAME

    /**
     * Model id of an existing note, read straight from the note row.
     *
     * `Note.MID` is not part of `AddContentApi`'s note projection, so this is the
     * one query the API wrapper cannot answer for us.
     */
    fun getNoteModelId(noteId: Long): Long? {
        val noteUri = Uri.withAppendedPath(FlashCardsContract.Note.CONTENT_URI, noteId.toString())
        val cursor = context.contentResolver.query(
            noteUri,
            arrayOf(FlashCardsContract.Note.MID),
            null,
            null,
            null,
        ) ?: return null
        return cursor.use {
            if (it.moveToNext()) it.getLong(it.getColumnIndexOrThrow(FlashCardsContract.Note.MID)) else null
        }
    }

    private companion object {
        const val DEFAULT_MODEL_NAME = "Default"
    }
}
