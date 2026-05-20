import browser from 'webextension-polyfill'
import { SETTINGS_KEY_ENABLED } from './consts'
import { clearAllHighlights, ensureStyles } from './highlighter'
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
 * Scope:
 *   - Loads vocabulary on startup, builds stem index.
 *   - Walks page once, span-wraps matches.
 *   - Watches DOM mutations for SPA navigation / infinite scroll.
 *   - Hover tooltip showing the saved description (line-clamped); click on
 *     a highlight invokes the caller-supplied `onActivate` to open the full
 *     translator popup.
 *   - Live refresh: background broadcasts a `vocabUpdated` message after
 *     putItem/deleteItem, every tab tears down and re-bootstraps so newly
 *     saved words light up without a reload.
 *
 * Not yet:
 *   - Per-site enable/disable UI.
 *   - CSS Custom Highlight API renderer.
 */

export interface BootstrapOptions {
    onActivate?: MountTooltipOptions['onActivate']
}

const REFRESH_DEBOUNCE_MS = 150
const REFRESH_MESSAGE_TYPE = 'vocabUpdated'

let teardown: (() => void) | null = null
let currentOpts: BootstrapOptions = {}
let updateListenerInstalled = false
let refreshTimer: number | null = null

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

const runBootstrap = async (opts: BootstrapOptions): Promise<void> => {
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
}

const performRefresh = async (): Promise<void> => {
    try {
        // Tear down observers, listeners, and the singleton tooltip — index
        // is captured in their closures, so we need a clean rebuild rather
        // than mutating the captured reference.
        if (teardown) {
            teardown()
            teardown = null
        }
        // Drop every previously-injected highlight span. The next scan only
        // re-wraps words present in the *new* index, so removed words clear
        // naturally and added words light up.
        clearAllHighlights()
        await runBootstrap(currentOpts)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] refresh failed', err)
    }
}

const scheduleRefresh = (): void => {
    // Debounce so a burst of putItem calls (rare today, but possible if a
    // future import-from-CSV lands) collapses into one rescan.
    if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        performRefresh()
    }, REFRESH_DEBOUNCE_MS)
}

const installVocabUpdatedListener = (): void => {
    if (updateListenerInstalled) return
    updateListenerInstalled = true
    // Return value left undefined — we don't ack, we don't respond async.
    // This keeps the polyfill from holding the message channel open.
    browser.runtime.onMessage.addListener((message: unknown) => {
        if (typeof message !== 'object' || message === null) return
        if ((message as { type?: unknown }).type !== REFRESH_MESSAGE_TYPE) return
        scheduleRefresh()
    })
}

export const bootstrapVocabularyHighlighter = async (opts: BootstrapOptions = {}): Promise<void> => {
    currentOpts = opts
    // Install the live-refresh listener even when the index is empty or the
    // feature is disabled — adding the first word later still needs to wake
    // us up. The listener itself is a single addListener call per page.
    installVocabUpdatedListener()
    try {
        await runBootstrap(opts)
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
    if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
        refreshTimer = null
    }
}
