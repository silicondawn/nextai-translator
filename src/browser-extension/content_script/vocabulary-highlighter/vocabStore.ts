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
    stemToDescription: Map<string, string>
    size: number
}

const EMPTY_INDEX: VocabIndex = {
    stemmedSet: new Set(),
    stemToOriginals: new Map(),
    stemToDescription: new Map(),
    size: 0,
}

interface RawVocabEntry {
    word: string
    description: string
}

const buildIndex = (entries: RawVocabEntry[]): VocabIndex => {
    const stemmedSet = new Set<string>()
    const stemToOriginals = new Map<string, string[]>()
    const stemToDescription = new Map<string, string>()
    for (const { word, description } of entries) {
        const lower = word.toLowerCase().trim()
        if (!lower) continue
        const s = stem(lower)
        stemmedSet.add(s)
        const list = stemToOriginals.get(s) ?? []
        list.push(word)
        stemToOriginals.set(s, list)
        // First non-empty description for a given stem wins. Prevents a later
        // inflection with a thinner note from clobbering an earlier rich one.
        const trimmed = description?.trim()
        if (trimmed && !stemToDescription.has(s)) {
            stemToDescription.set(s, trimmed)
        }
    }
    return { stemmedSet, stemToOriginals, stemToDescription, size: stemmedSet.size }
}

/**
 * Pulls the full vocabulary from background, builds the index.
 * Caller is responsible for deciding when to refresh (initial mount,
 * after a "word added" event, etc.) — the store itself is stateless.
 */
export const loadVocabIndex = async (): Promise<VocabIndex> => {
    try {
        const items = await vocabularyService.listItems()
        return buildIndex(items.map((it) => ({ word: it.word, description: it.description ?? '' })))
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

export const lookupDescription = (index: VocabIndex, word: string): string | null => {
    if (index.size === 0) return null
    return index.stemToDescription.get(stem(word.toLowerCase())) ?? null
}
