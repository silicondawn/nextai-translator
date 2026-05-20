import browser from 'webextension-polyfill'
import { SETTINGS_KEY_ENABLED } from './consts'
import { clearAllHighlights, ensureStyles } from './highlighter'
import { scanDocument, startMutationObserver } from './scanner'
import { mountTooltip, MountTooltipOptions, refreshTooltipContent } from './tooltip'
import { loadVocabIndex, VocabIndex } from './vocabStore'

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
 *   - Hover tooltip showing the saved description; click on a highlight
 *     invokes the caller-supplied `onActivate` to open the full translator.
 *   - Live refresh: background broadcasts a `vocabUpdated` message after
 *     putItem/deleteItem. A description-only change updates the tooltip
 *     in place (no DOM rebuild); add/remove triggers a full rescan.
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

const EMPTY_INDEX: VocabIndex = {
    stemmedSet: new Set(),
    stemToOriginals: new Map(),
    stemToDescription: new Map(),
    size: 0,
}

let teardown: (() => void) | null = null
let currentOpts: BootstrapOptions = {}
let currentIndex: VocabIndex = EMPTY_INDEX
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

const stemmedSetsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) return false
    for (const s of a) if (!b.has(s)) return false
    return true
}

const runBootstrap = async (opts: BootstrapOptions): Promise<void> => {
    if (!isPageEligible()) return
    if (!(await isEnabled())) return

    const index = await loadVocabIndex()
    currentIndex = index
    if (index.size === 0) return

    ensureStyles()
    scanDocument(index)
    const stopMutations = startMutationObserver(() => currentIndex)
    const stopTooltip = mountTooltip({ getIndex: () => currentIndex, onActivate: opts.onActivate })
    teardown = () => {
        stopMutations()
        stopTooltip()
    }
}

const performRefresh = async (): Promise<void> => {
    try {
        const old = currentIndex
        const fresh = await loadVocabIndex()

        // Fast path: word set unchanged (the streaming silent-save case —
        // we're just filling in a description). The MutationObserver and
        // tooltip both read currentIndex through a getter, so swapping it
        // is enough to surface the new text. Update the tooltip's visible
        // content if the user is hovering right now.
        if (teardown !== null && stemmedSetsEqual(old.stemmedSet, fresh.stemmedSet)) {
            currentIndex = fresh
            refreshTooltipContent()
            return
        }

        // Slow path: words were added or removed. Tear down highlights and
        // rebuild — cheaper than tracking per-span add/remove for the volume
        // we expect (single-digit changes per refresh).
        if (teardown) {
            teardown()
            teardown = null
        }
        clearAllHighlights()
        await runBootstrap(currentOpts)
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[vocab-highlight] refresh failed', err)
    }
}

const scheduleRefresh = (): void => {
    // Debounce so a burst of putItem calls (e.g. streaming partial
    // descriptions every 600ms) collapses sensibly under load.
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
    currentIndex = EMPTY_INDEX
}
