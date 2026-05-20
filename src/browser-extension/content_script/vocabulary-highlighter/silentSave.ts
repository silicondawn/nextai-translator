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
        const controller = new AbortController()

        await translate({
            action,
            text: word,
            selectedWord: word,
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
            },
            onError: (err) => {
                // eslint-disable-next-line no-console
                console.warn('[vocab-highlight] background translate error', err)
            },
            onFinish: (reason) => {
                finishedReason = reason
            },
        })

        if (finishedReason === null) return

        const full = chunks.join('').trim()
        if (!full) return

        // The regular flow stores `translatedText.slice(word.length+1)` —
        // i.e. everything after the leading "word\n". Mirror that so the
        // description format matches what Translator.tsx would write.
        const desc = full.toLowerCase().startsWith(word.toLowerCase())
            ? full.slice(word.length).replace(/^[\s\n]+/, '').trim()
            : full

        const existing = await vocabularyService.getItem(word)
        await vocabularyService.putItem({
            word,
            reviewCount: existing?.reviewCount ?? 1,
            description: desc || full,
            updatedAt: nowStamp(),
            createdAt: existing?.createdAt ?? nowStamp(),
        })
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] background translate exception', err)
    }
}
