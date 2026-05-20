import browser from 'webextension-polyfill'
import { SETTINGS_KEY_ENABLED } from './consts'
import { ensureStyles } from './highlighter'
import { scanDocument, startMutationObserver } from './scanner'
import { mountTooltip, MountTooltipOptions } from './tooltip'
import { loadVocabIndex } from './vocabStore'

/**
 * Vocabulary Highlighter — public API.
 *
 * Call `bootstrapVocabularyHighlighter()` once from the content script entry
 * (`src/browser-extension/content_script/index.tsx`). It is fully self-
 * contained: failures are swallowed and logged so a buggy highlight pass
 * never breaks the translator's primary selection-translation flow.
 *
 * MVP scope:
 *   - Loads vocabulary on startup, builds stem index.
 *   - Walks page once, span-wraps matches.
 *   - Watches DOM mutations for SPA navigation / infinite scroll.
 *   - Hover tooltip showing the saved description (line-clamped); click on
 *     a highlight invokes the caller-supplied `onActivate` to open the full
 *     translator popup.
 *
 * Not in MVP (tracked in module README):
 *   - Reactive refresh when a word is added/removed mid-session.
 *   - Per-site enable/disable UI.
 *   - CSS Custom Highlight API renderer.
 */

export interface BootstrapOptions {
    onActivate?: MountTooltipOptions['onActivate']
}

let teardown: (() => void) | null = null

const isEnabled = async (): Promise<boolean> => {
    try {
        const stored = await browser.storage.local.get(SETTINGS_KEY_ENABLED)
        const v = stored[SETTINGS_KEY_ENABLED]
        // Default ON when key absent — MVP wants to be visible by default for testing.
        return v === undefined ? true : Boolean(v)
    } catch {
        return true
    }
}

const isPageEligible = (): boolean => {
    // Don't run in nested frames for now — too much variance in iframe contexts
    // (sandbox attrs, cross-origin restrictions). Top frame only for MVP.
    if (window !== window.top) return false
    if (!document.body) return false
    return true
}

export const bootstrapVocabularyHighlighter = async (opts: BootstrapOptions = {}): Promise<void> => {
    try {
        if (!isPageEligible()) return
        if (!(await isEnabled())) return

        const index = await loadVocabIndex()
        if (index.size === 0) return

        ensureStyles()
        scanDocument(index)
        const stopMutations = startMutationObserver(index)
        const stopTooltip = mountTooltip({ index, onActivate: opts.onActivate })
        teardown = () => {
            stopMutations()
            stopTooltip()
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] bootstrap failed', err)
    }
}

export const teardownVocabularyHighlighter = (): void => {
    if (teardown) {
        teardown()
        teardown = null
    }
}
