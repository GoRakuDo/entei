package org.gorakudo.entei.modules.ankidroid

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import com.ichi2.anki.FlashCardsContract

/**
 * Card reads, search and suspend, reached through a synthetic card id.
 *
 * AnkiDroid never exposes a card id: a card is the pair `(noteId, ord)` living in
 * the note's `cards` sub-uri. Entei's web layer speaks AnkiConnect, where a card
 * id is one number (`findCards` -> `suspend`, `cardsInfo`), so the pair is packed
 * into a single decimal number:
 *
 *     cardId = noteId * 1000 + ord
 *
 * `noteId` is epoch milliseconds (13 digits, ~1.7e12), so the packed value tops
 * out around 1.7e15 — inside JavaScript's `Number.MAX_SAFE_INTEGER`
 * (9,007,199,254,740,991). A webview round trip therefore cannot lose a digit,
 * and a suspend can never hit the wrong card. This is §4.4 of
 * ANKIDROID_MODULE_ARCHITECTURE.md; the packing itself lives in the companion
 * object so the arithmetic has exactly one definition.
 */
class CardApi(
    private val context: Context,
    private val decks: DeckApi = DeckApi(context),
    private val models: ModelApi = ModelApi(context),
    private val notes: NoteApi = NoteApi(context, decks, models),
) {

    /**
     * AnkiConnect `findCards`: expand a note query into synthetic card ids.
     *
     * The query is resolved by [NoteApi.findNotes] (libanki browser syntax), then
     * every matching note contributes one id per card ordinal.
     */
    fun findCards(query: String): List<Long> {
        val cardIds = mutableListOf<Long>()
        for (noteId in notes.findNotes(query)) {
            for (ord in cardOrdsOf(noteId)) {
                cardIds.add(makeCardId(noteId, ord.toLong()))
            }
        }
        return cardIds
    }

    /**
     * AnkiConnect `cardsInfo`: deck name, model name and rendered front/back.
     *
     * The deck name per card is what fills the append panel's Deck column, so an
     * unresolvable deck is reported as an empty string rather than dropping the
     * card out of the list.
     */
    fun cardsInfo(cardIds: List<Long>): List<Map<String, Any>> {
        val cards = mutableListOf<Map<String, Any>>()
        for (cardId in cardIds) {
            // One dead id (a card deleted on another device since the search, or
            // a bogus id from the web layer) must not take the whole panel down:
            // the surviving cards are still worth showing.
            try {
                val noteId = parseNoteId(cardId)
                val ord = parseCardOrd(cardId)
                val row = cardRowOf(noteId, ord) ?: continue
                val modelId = models.getNoteModelId(noteId)
                cards.add(
                    mapOf(
                        "cardId" to cardId,
                        "deckName" to (decks.getDeckName(row.deckId) ?: ""),
                        // An unresolved model reports AnkiDroid's "Default" fallback
                        // rather than blanking out the panel's note-type column.
                        "modelName" to models.getModelName(modelId ?: 0L),
                        "question" to row.question,
                        "answer" to row.answer,
                    )
                )
            } catch (error: Exception) {
                continue
            }
        }
        return cards
    }

    /**
     * AnkiConnect `suspend`.
     *
     * Suspension is not a card write: it goes through `ReviewInfo`, where
     * `note_id` + `ord` identify the card and `suspended = 1` requests the
     * action (mutually exclusive with answering/burying). One card per update —
     * the provider reads a single `(note_id, ord)` pair out of the values.
     *
     * @return true only when every card was accepted by AnkiDroid.
     */
    fun suspend(cardIds: List<Long>): Boolean {
        var allSuspended = true
        for (cardId in cardIds) {
            // Per-id isolation: a card that AnkiDroid refuses (deleted, or a
            // provider error on that row) marks the batch as incomplete but must
            // not stop the remaining cards from being suspended.
            try {
                val values = ContentValues().apply {
                    put(FlashCardsContract.ReviewInfo.NOTE_ID, parseNoteId(cardId))
                    put(FlashCardsContract.ReviewInfo.CARD_ORD, parseCardOrd(cardId))
                    put(FlashCardsContract.ReviewInfo.SUSPEND, 1)
                }
                val updated = context.contentResolver.update(
                    FlashCardsContract.ReviewInfo.CONTENT_URI,
                    values,
                    null,
                    null,
                )
                if (updated <= 0) allSuspended = false
            } catch (error: Exception) {
                allSuspended = false
            }
        }
        return allSuspended
    }

    /**
     * AnkiConnect `notesInfo`: the full note object the append panel and the
     * latest-card update path validate against.
     *
     * `fields` is rebuilt in model order as `{ fieldName: { value, order } }`
     * (AnkiConnect's shape), and `cards` carries the synthetic card ids so the
     * caller can resolve deck names through [cardsInfo] without a second search.
     */
    fun notesInfo(noteIds: List<Long>): List<Map<String, Any>> {
        val result = mutableListOf<Map<String, Any>>()
        for (noteId in noteIds) {
            val note = notes.getNote(noteId) ?: continue
            val modelId = models.getNoteModelId(noteId) ?: 0L
            val fieldNames = models.modelFieldNamesById(modelId)
            val values = note.fields
            val fields = LinkedHashMap<String, Any>(fieldNames.size)
            fieldNames.forEachIndexed { order, fieldName ->
                fields[fieldName] = mapOf(
                    "value" to (values.getOrNull(order) ?: ""),
                    "order" to order,
                )
            }

            val cards = cardOrdsOf(noteId).map { makeCardId(noteId, it.toLong()) }
            result.add(
                mapOf(
                    "noteId" to noteId,
                    "modelName" to models.getModelName(modelId),
                    "deckName" to (deckNameOf(noteId) ?: ""),
                    "fields" to fields,
                    // Blank tags are dropped here too: the append panel renders
                    // these verbatim, and an empty chip is a rendering artefact.
                    "tags" to note.tags.filter { it.isNotBlank() },
                    "cards" to cards,
                )
            )
        }
        return result
    }

    /** The deck of a note's first card, or null when the note has no cards left. */
    private fun deckNameOf(noteId: Long): String? {
        val deckId = firstCardDeckIdOf(noteId) ?: return null
        return decks.getDeckName(deckId)
    }

    private fun firstCardDeckIdOf(noteId: Long): Long? {
        val cursor = context.contentResolver.query(
            cardsUriOf(noteId),
            arrayOf(FlashCardsContract.Card.DECK_ID),
            null,
            null,
            null,
        ) ?: return null
        return cursor.use {
            if (it.moveToNext()) {
                it.getLong(it.getColumnIndexOrThrow(FlashCardsContract.Card.DECK_ID))
            } else {
                null
            }
        }
    }

    /** Card ordinals of a note (`notes/<noteId>/cards`). */
    private fun cardOrdsOf(noteId: Long): List<Int> {
        val cursor = context.contentResolver.query(
            cardsUriOf(noteId),
            arrayOf(FlashCardsContract.Card.CARD_ORD),
            null,
            null,
            null,
        ) ?: return emptyList()
        val ords = mutableListOf<Int>()
        cursor.use {
            val ordIndex = it.getColumnIndexOrThrow(FlashCardsContract.Card.CARD_ORD)
            while (it.moveToNext()) ords.add(it.getInt(ordIndex))
        }
        return ords
    }

    /** One card's read-only columns; null when the card no longer exists. */
    private fun cardRowOf(noteId: Long, ord: Int): CardRow? {
        val cursor = context.contentResolver.query(
            cardUriOf(noteId, ord),
            CARD_PROJECTION,
            null,
            null,
            null,
        ) ?: return null
        return cursor.use {
            if (it.moveToNext()) {
                CardRow(
                    deckId = it.getLong(
                        it.getColumnIndexOrThrow(FlashCardsContract.Card.DECK_ID)
                    ),
                    question = it.getString(
                        it.getColumnIndexOrThrow(FlashCardsContract.Card.QUESTION)
                    ) ?: "",
                    answer = it.getString(
                        it.getColumnIndexOrThrow(FlashCardsContract.Card.ANSWER)
                    ) ?: "",
                )
            } else {
                null
            }
        }
    }

    private fun cardsUriOf(noteId: Long): Uri = Uri.withAppendedPath(
        Uri.withAppendedPath(FlashCardsContract.Note.CONTENT_URI, noteId.toString()),
        CARDS_SEGMENT,
    )

    private fun cardUriOf(noteId: Long, ord: Int): Uri =
        Uri.withAppendedPath(cardsUriOf(noteId), ord.toString())

    private data class CardRow(val deckId: Long, val question: String, val answer: String)

    companion object {
        /** Packed ids keep at most three decimal digits of card ordinal. */
        private const val CARD_ORD_SCALE = 1000L

        private const val CARDS_SEGMENT = "cards"

        /** Only columns `CardContentProvider.addCardToCursor` can serve. */
        private val CARD_PROJECTION = arrayOf(
            FlashCardsContract.Card.NOTE_ID,
            FlashCardsContract.Card.CARD_ORD,
            FlashCardsContract.Card.DECK_ID,
            FlashCardsContract.Card.QUESTION,
            FlashCardsContract.Card.ANSWER,
        )

        /** `cardId = noteId * 1000 + (ord % 1000)`. */
        fun makeCardId(noteId: Long, cardOrd: Long): Long =
            noteId * CARD_ORD_SCALE + (cardOrd % CARD_ORD_SCALE)

        /** Unpack the note half of a synthetic card id. */
        fun parseNoteId(cardId: Long): Long = cardId / CARD_ORD_SCALE

        /** Unpack the card ordinal half of a synthetic card id. */
        fun parseCardOrd(cardId: Long): Int = (cardId % CARD_ORD_SCALE).toInt()
    }
}
