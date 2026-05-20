import { actionService } from '@/common/services/action'
import { vocabularyService } from '@/common/services/vocabulary'
import { getSettings } from '@/common/utils'
import { isAWord, translate } from '@/common/translate'
import { LangCode } from '@/common/lang'

/**
 * Silent-save flow for the popup thumb's new bookmark button.
 *
 * Goal: user selects an unknown word and clicks the button. The word is
 * marked on the page immediately (yellow highlight via the existing
 * live-refresh broadcast); the translator engine runs in the background;
 * the description fills in seconds later. The full translator card never
 * opens, so the user keeps reading.
 *
 * This is the one place the highlighter module reaches into the broader
 * translator stack — translate(), actionService, and the user's settings.
 * Everything else in vocabulary-highlighter/ stays self-contained.
 */

interface SilentSaveResult {
    ok: boolean
    skipped?: 'empty' | 'not-a-word' | 'already-described'
    word?: string
}

// Same character class the page scanner accepts. Phrases / CJK / accented
// chars are outside the highlighter's MVP scope and would mis-stem anyway.
const ASCII_WORD_RE = /^[A-Za-z][A-Za-z'-]*$/

const nowStamp = (): string => Date.now().toString()

export const silentSaveWord = async (rawText: string): Promise<SilentSaveResult> => {
    const word = rawText.trim()
    if (!word) return { ok: false, skipped: 'empty' }
    if (!ASCII_WORD_RE.test(word)) return { ok: false, skipped: 'not-a-word' }

    try {
        const settings = await getSettings()
        const sourceLang = ((settings as { defaultSourceLanguage?: string }).defaultSourceLanguage ?? 'en') as LangCode
        const targetLang = (settings.defaultTargetLanguage ?? 'zh-Hans') as LangCode

        // Skip multi-token strings that Intl.Segmenter doesn't consider one word.
        if (!isAWord(sourceLang, word)) return { ok: false, skipped: 'not-a-word' }

        const existing = await vocabularyService.getItem(word)
        if (existing && existing.description) {
            // Already collected with a real description — just bump reviewCount.
            await vocabularyService.putItem({
                ...existing,
                reviewCount: existing.reviewCount + 1,
                updatedAt: nowStamp(),
            })
            return { ok: true, skipped: 'already-described', word }
        }

        // Insert (or upgrade) with empty description first. The background
        // broadcasts vocabUpdated, every tab re-scans, the yellow highlight
        // appears within ~150ms.
        const stamp = nowStamp()
        await vocabularyService.putItem({
            word,
            reviewCount: existing?.reviewCount ?? 1,
            description: '',
            updatedAt: stamp,
            createdAt: existing?.createdAt ?? stamp,
        })

        // Fire and forget — translation may take seconds; the user already
        // moved on. When it finishes we write again and a second broadcast
        // refreshes the tooltip content.
        void runBackgroundTranslation(word, sourceLang, targetLang)

        return { ok: true, word }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] silent save failed', err)
        return { ok: false, word }
    }
}

// Time between partial writes during streaming. Each write triggers a
// vocabUpdated broadcast → fast-path refresh → tooltip rerender, so the
// user watches the description fill in instead of staring at "翻译中…".
const PARTIAL_FLUSH_THROTTLE_MS = 600

// Mirror Translator.tsx's storage shape: drop the leading "word\n" header
// the prompt is instructed to emit, so the description starts with the
// actual definition / phonetic line.
const formatDescription = (word: string, raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (trimmed.toLowerCase().startsWith(word.toLowerCase())) {
        const stripped = trimmed.slice(word.length).replace(/^[\s\n]+/, '').trim()
        return stripped || trimmed
    }
    return trimmed
}

const runBackgroundTranslation = async (
    word: string,
    sourceLang: LangCode,
    targetLang: LangCode
): Promise<void> => {
    try {
        const action = await actionService.getByMode('translate')
        if (!action) return

        const chunks: string[] = []
        let finishedReason: string | null = null
        let lastFlushAt = 0
        let flushInFlight = false
        let lastFlushedDescription = ''
        const controller = new AbortController()

        const flushPartial = async (): Promise<void> => {
            if (flushInFlight) return
            const description = formatDescription(word, chunks.join(''))
            if (!description || description === lastFlushedDescription) return
            flushInFlight = true
            try {
                const existing = await vocabularyService.getItem(word)
                // The user may have deleted this word from their vocabulary
                // book while we were streaming — don't resurrect it. Abort
                // the rest of the translation too: there's no entry to fill.
                if (!existing) {
                    controller.abort()
                    return
                }
                await vocabularyService.putItem({
                    ...existing,
                    description,
                    updatedAt: nowStamp(),
                })
                lastFlushedDescription = description
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[vocab-highlight] partial flush failed', err)
            } finally {
                lastFlushAt = Date.now()
                flushInFlight = false
            }
        }

        await translate({
            action,
            // text-only, no `selectedWord` — passing both flips translate.ts
            // into "word-in-sentence" mode (line 346), whose prompt template
            // emits literal '<word>' / '<the remaining part>' placeholders
            // when there's no real sentence context to substitute them with.
            text: word,
            detectFrom: sourceLang,
            detectTo: targetLang,
            signal: controller.signal,
            onMessage: async (m) => {
                if (!m.content) return
                if (m.isFullText) {
                    chunks.length = 0
                    chunks.push(m.content)
                } else {
                    chunks.push(m.content)
                }
                if (Date.now() - lastFlushAt >= PARTIAL_FLUSH_THROTTLE_MS) {
                    // Fire-and-forget: keep streaming responsive while the
                    // putItem RPC and downstream broadcast happen in parallel.
                    void flushPartial()
                }
            },
            onError: (err) => {
                // eslint-disable-next-line no-console
                console.warn('[vocab-highlight] background translate error', err)
            },
            onFinish: (reason) => {
                finishedReason = reason
            },
        })

        // Drain any in-flight partial flush so the final write definitely wins.
        while (flushInFlight) {
            await new Promise((r) => setTimeout(r, 30))
        }
        if (finishedReason === null) return

        const finalDescription = formatDescription(word, chunks.join(''))
        if (!finalDescription || finalDescription === lastFlushedDescription) return

        const existing = await vocabularyService.getItem(word)
        // Same guard as flushPartial: if the entry has been deleted from the
        // vocabulary book during streaming, don't resurrect it here.
        if (!existing) return
        await vocabularyService.putItem({
            ...existing,
            description: finalDescription,
            updatedAt: nowStamp(),
        })
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] background translate exception', err)
    }
}
