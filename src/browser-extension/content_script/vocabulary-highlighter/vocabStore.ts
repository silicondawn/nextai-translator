import { vocabularyService } from '@/common/services/vocabulary'
import { stem } from './stemmer'

/**
 * In-memory index built from the user's vocabulary book.
 *
 * `stemmedSet` is the hot path: O(1) membership check during page scan.
 * `stemToOriginals` lets the (eventual) hover tooltip recover the form
 * the user actually saved — useful when several stored words collapse
 * to the same stem.
 */
export interface VocabIndex {
    stemmedSet: Set<string>
    stemToOriginals: Map<string, string[]>
    size: number
}

const EMPTY_INDEX: VocabIndex = {
    stemmedSet: new Set(),
    stemToOriginals: new Map(),
    size: 0,
}

const buildIndex = (words: string[]): VocabIndex => {
    const stemmedSet = new Set<string>()
    const stemToOriginals = new Map<string, string[]>()
    for (const word of words) {
        const lower = word.toLowerCase().trim()
        if (!lower) continue
        const s = stem(lower)
        stemmedSet.add(s)
        const list = stemToOriginals.get(s) ?? []
        list.push(word)
        stemToOriginals.set(s, list)
    }
    return { stemmedSet, stemToOriginals, size: stemmedSet.size }
}

/**
 * Pulls the full vocabulary from background, builds the index.
 * Caller is responsible for deciding when to refresh (initial mount,
 * after a "word added" event, etc.) — the store itself is stateless.
 */
export const loadVocabIndex = async (): Promise<VocabIndex> => {
    try {
        const items = await vocabularyService.listItems()
        return buildIndex(items.map((it) => it.word))
    } catch (err) {
        // Vocabulary table not yet initialised on a fresh install, or DB error.
        // Fail soft: highlighting just stays inert.
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] failed to load vocabulary', err)
        return EMPTY_INDEX
    }
}

export const isMatch = (index: VocabIndex, word: string): boolean => {
    if (index.size === 0) return false
    return index.stemmedSet.has(stem(word.toLowerCase()))
}

export const lookupOriginals = (index: VocabIndex, word: string): string[] => {
    return index.stemToOriginals.get(stem(word.toLowerCase())) ?? []
}
