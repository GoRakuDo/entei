package org.gorakudo.entei.modules.ankidroid

import android.content.Context
import com.ichi2.anki.api.AddContentApi

/**
 * Deck reads and id/name resolution.
 *
 * AnkiDroid hands out decks as `deckId -> deckName` (`AddContentApi.getDeckList`),
 * which is the opposite direction from AnkiConnect's `{ deckName: deckId }`. This
 * class is the single place that owns both directions, so `addNote` (needs an id)
 * and `cardsInfo` / `notesInfo` (need a name) never translate by hand.
 */
class DeckApi(context: Context) {

    // A thin ContentResolver wrapper — one per request costs nothing.
    private val api = AddContentApi(context)

    /** `deckId -> deckName`, or null when AnkiDroid could not answer. */
    val deckList: Map<Long, String>?
        get() = api.deckList

    /** AnkiConnect `deckNames`: every deck name, unordered as AnkiDroid returns it. */
    fun deckNames(): Array<String> = deckList?.values?.toTypedArray() ?: emptyArray()

    /** AnkiConnect `deckNamesAndIds`: `{ deckName: deckId }`. */
    fun deckNamesAndIds(): Map<String, Long> =
        deckList?.entries?.associate { it.value to it.key } ?: emptyMap()

    /**
     * Resolve a deck name to its id.
     *
     * Fails loudly on purpose: a typo'd deck must never silently drop the new
     * card into AnkiDroid's default deck.
     */
    fun getDeckId(name: String): Long =
        deckNamesAndIds()[name] ?: throw Exception("Deck not found: $name")

    /** Deck name for a card's `deck_id`, or null when that deck is gone. */
    fun getDeckName(deckId: Long): String? = deckList?.get(deckId)
}
