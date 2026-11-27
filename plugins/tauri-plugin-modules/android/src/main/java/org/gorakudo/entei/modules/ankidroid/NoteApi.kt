package org.gorakudo.entei.modules.ankidroid

import android.content.Context
import com.ichi2.anki.FlashCardsContract
import com.ichi2.anki.api.AddContentApi
import com.ichi2.anki.api.NoteInfo

/**
 * Note writes and lookups: duplicate checks, creation, field updates, tags and
 * Anki search.
 *
 * The field ordering contract is the whole difficulty here: AnkiDroid stores a
 * note as a positional `flds` array in **model field order**, while AnkiConnect
 * speaks `{ fieldName: value }` maps. Every method below converts at this
 * boundary and nowhere else.
 */
class NoteApi(
    private val context: Context,
    private val decks: DeckApi = DeckApi(context),
    private val models: ModelApi = ModelApi(context),
) {

    private val api = AddContentApi(context)

    /**
     * AnkiConnect `canAddNotes`: one boolean per note, in request order.
     *
     * A note is addable when its first field is non-empty and either duplicates
     * are allowed or AnkiDroid has no note of the same model with that first
     * field value. An empty first field is answered `false` rather than thrown:
     * `addNote` would reject it anyway, and Anki treats the first field as the
     * note's search key.
     */
    fun canAddNotes(notes: List<Map<String, Any?>>): BooleanArray =
        BooleanArray(notes.size) { index ->
            val note = notes[index]
            val modelName = note["modelName"] as? String
                ?: throw Exception("Note is missing modelName")
            val fields = stringFieldsOf(note["fields"])
            val modelId = models.getModelId(modelName)
            val firstFieldName = models.modelFieldNamesById(modelId).firstOrNull()
                ?: throw Exception("Fields not found for model $modelName")
            val key = fields[firstFieldName].orEmpty()

            when {
                key.isBlank() -> false
                allowDuplicateOf(note["options"]) -> true
                else -> api.findDuplicateNotes(modelId, key).isEmpty()
            }
        }

    /**
     * AnkiConnect `addNote`: create the note and return its id.
     *
     * Field values are reordered into model order; anything the caller did not
     * send becomes `""` (AnkiDroid requires the array to be exactly as long as
     * the model's field list).
     */
    fun addNote(
        modelName: String,
        deckName: String,
        fields: Map<String, String>,
        tags: List<String>,
    ): Long {
        val modelId = models.getModelId(modelName)
        val deckId = decks.getDeckId(deckName)
        val fieldValues = orderedFieldsOf(modelId, modelName, fields)
        val tagSet = tags.filter { it.isNotBlank() }.toSet()
        return api.addNote(modelId, deckId, fieldValues, tagSet)
            ?: throw Exception("Failed to add note to AnkiDroid")
    }

    /**
     * AnkiConnect `updateNoteFields` — read, merge, then replace.
     *
     * `AddContentApi.updateNoteFields` overwrites the **whole** `flds` array, so
     * writing only the incoming fields would blank every field the caller did
     * not send (the export path sends text fields only, never image/audio). The
     * merge below rebuilds the full model-ordered array from what is stored and
     * lets the incoming map win field by field — the data-loss guard §4.3③ of
     * ANKIDROID_MODULE_ARCHITECTURE.md requires.
     *
     * @return true when AnkiDroid reported the note as updated.
     */
    fun updateNoteFields(noteId: Long, incomingFields: Map<String, String>): Boolean {
        val modelId = models.getNoteModelId(noteId)
            ?: throw Exception("Model not found for note $noteId")
        val fieldNames = models.modelFieldNamesById(modelId)
        if (fieldNames.isEmpty()) throw Exception("Fields not found for model $modelId")

        val existingNote = api.getNote(noteId) ?: throw Exception("Note not found: $noteId")
        val existingFields = existingNote.getFields()

        val mergedFields = Array(fieldNames.size) { index ->
            if (incomingFields.containsKey(fieldNames[index])) {
                incomingFields[fieldNames[index]] ?: ""
            } else {
                existingFields.getOrNull(index) ?: ""
            }
        }

        return api.updateNoteFields(noteId, mergedFields)
    }

    /**
     * AnkiConnect `addTags` — additive only.
     *
     * AnkiDroid's `updateNoteTags` also replaces the whole tag set, so existing
     * tags are read first and unioned with the incoming ones. A `false` return
     * (note gone) is escalated as an error: a silently dropped tag would make the
     * export look successful while the card is untagged.
     */
    fun addTags(noteIds: List<Long>, tagsString: String) {
        val incoming = tagsString.trim().split(TAG_SEPARATOR)
            // A blank tag is a wire artefact (trailing whitespace, an empty
            // "" between separators); Anki treats tags as search keys, so
            // storing one would be invisible and unusable.
            .filter { it.isNotBlank() }
            .toSet()
        if (incoming.isEmpty()) return

        for (noteId in noteIds) {
            val note = api.getNote(noteId) ?: throw Exception("Note not found: $noteId")
            // Existing tags are re-read because updateNoteTags replaces the whole
            // set: a blank stored tag must not be carried over either.
            val union = LinkedHashSet<String>()
            note.getTags()?.filterTo(union) { it.isNotBlank() }
            union.addAll(incoming)
            if (!api.updateNoteTags(noteId, union)) {
                throw Exception("Failed to add tags to note $noteId")
            }
        }
    }

    /**
     * Read one stored note (fields in model order, plus its tags).
     *
     * Shared by [updateNoteFields]'s read-before-write merge and by `notesInfo`,
     * both of which must see what AnkiDroid actually stores.
     */
    fun getNote(noteId: Long): NoteInfo? = api.getNote(noteId)

    /**
     * AnkiConnect `findNotes`.
     *
     * The `notes` ContentProvider uri runs its selection through libanki's
     * browser search (`CardContentProvider.query` -> `Collection.findNotes`), so
     * the query string is passed through verbatim and `added:1`, `nid:`,
     * `deck:"..."`, `is:suspended`, ... behave exactly as they do in Anki's own
     * browser. AnkiDroid answers a query with no hits with a null cursor, which
     * the AnkiConnect contract reports as an empty array — never `null`.
     */
    fun findNotes(query: String): List<Long> {
        val trimmed = query.trim()
        // An empty query means "every note" to libanki; callers never want the
        // whole collection dumped through the webview, so treat it as no hits.
        if (trimmed.isEmpty()) return emptyList()

        val cursor = context.contentResolver.query(
            FlashCardsContract.Note.CONTENT_URI,
            arrayOf(FlashCardsContract.Note._ID),
            trimmed,
            null,
            null,
        ) ?: return emptyList()

        val noteIds = mutableListOf<Long>()
        cursor.use {
            val idIndex = it.getColumnIndexOrThrow(FlashCardsContract.Note._ID)
            while (it.moveToNext()) noteIds.add(it.getLong(idIndex))
        }
        return noteIds
    }

    /** Build the model-ordered `flds` array for a note we are about to create. */
    private fun orderedFieldsOf(
        modelId: Long,
        modelName: String,
        fields: Map<String, String>,
    ): Array<String> {
        val fieldNames = models.modelFieldNamesById(modelId)
        if (fieldNames.isEmpty()) throw Exception("Fields not found for model $modelName")
        return Array(fieldNames.size) { index -> fields[fieldNames[index]] ?: "" }
    }

    /** Read `note.fields` (`{ fieldName: value }`) out of a decoded request map. */
    private fun stringFieldsOf(fields: Any?): Map<String, String> {
        val map = fields as? Map<*, *> ?: return emptyMap()
        return map.entries.associate { (key, value) ->
            key.toString() to (value?.toString() ?: "")
        }
    }

    /** Read `note.options.allowDuplicate`. */
    private fun allowDuplicateOf(options: Any?): Boolean {
        val map = options as? Map<*, *> ?: return false
        return map["allowDuplicate"] == true
    }

    private companion object {
        /** AnkiConnect takes one whitespace-separated tag string. */
        val TAG_SEPARATOR = Regex("\\s+")
    }
}
