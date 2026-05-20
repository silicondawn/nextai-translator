import { popupCardID, popupThumbID } from '../consts'
import { MAX_TEXT_NODES, MUTATION_DEBOUNCE_MS, SCAN_CHUNK_SIZE, TOOLTIP_ELEMENT_ID } from './consts'
import { dropRangesOnTextNode, highlightTextNode, pruneDeadRanges } from './highlighter'
import { VocabIndex } from './vocabStore'

/**
 * DOM traversal & scheduling layer.
 *
 * - Walks text nodes via TreeWalker.
 * - Skips form fields, code blocks, contenteditable, and the translator's
 *   own popup chrome (don't highlight inside our own UI).
 * - Slices the work into idle-callback chunks so we never block the main
 *   thread for more than ~5ms at a time.
 * - Reacts to DOM mutations with a debounced incremental scan, so
 *   infinite-scroll feeds (Twitter, Reddit, blogs) stay covered.
 * - Cancellable: every in-flight idle scan is gated on a monotonically
 *   increasing epoch. `cancelInFlightScans()` bumps the epoch, so any
 *   queued tick exits at its next callback without touching the new
 *   vocab index.
 * - Watches `characterData` mutations too (React/Vue text interpolation
 *   replaces a node's text in place rather than swapping the node), and
 *   prunes stale ranges on `removedNodes` so detached highlights don't
 *   linger in memory.
 */

// Tags whose text content we never highlight.
const SKIP_TAGS: Record<string, true> = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEXTAREA: true,
    INPUT: true,
    SELECT: true,
    OPTION: true,
    CODE: true,
    PRE: true,
    KBD: true,
    SAMP: true,
}

const shouldSkipNode = (node: Node): boolean => {
    let cur: Node | null = node.parentNode
    while (cur) {
        if (cur.nodeType === Node.ELEMENT_NODE) {
            const el = cur as HTMLElement
            if (SKIP_TAGS[el.tagName]) return true
            if (el.isContentEditable) return true
            if (el.id === popupCardID || el.id === popupThumbID) return true
            // Don't highlight inside our own hover tooltip — its content is
            // already-saved descriptions, recursive highlighting is noise.
            if (el.id === TOOLTIP_ELEMENT_ID) return true
            // (No span-based highlight class to skip any more — the Custom
            // Highlight API renderer leaves the host DOM untouched.)
        }
        cur = cur.parentNode
    }
    return false
}

// Collect every text node under `root` (TreeWalker is depth-first by default).
const collectTextNodes = (root: Node, limit: number): Text[] => {
    const out: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
            const text = n.nodeValue
            if (!text || text.trim().length === 0) return NodeFilter.FILTER_REJECT
            if (shouldSkipNode(n)) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
        },
    })
    let cur: Node | null
    while ((cur = walker.nextNode())) {
        out.push(cur as Text)
        if (out.length >= limit) break
    }
    return out
}

// Bumped by `cancelInFlightScans`. Each idle tick captures its epoch and
// bails on next entry once a newer epoch is seen — so a queued scan that
// was about to highlight under the *old* index can never write into the
// post-teardown world.
let scanEpoch = 0
// The id of the most-recently-scheduled idle/timeout callback so we can
// cancel it pre-flight when teardown happens between ticks.
let pendingIdle: { type: 'idle' | 'timeout'; id: number } | null = null

const requestIdle = (cb: (deadline: IdleDeadline) => void): void => {
    if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(cb, { timeout: 1000 })
        pendingIdle = { type: 'idle', id }
    } else {
        // Safari fallback (Tauri/Safari builds).
        const id = window.setTimeout(() => cb({ timeRemaining: () => 16, didTimeout: false } as IdleDeadline), 16)
        pendingIdle = { type: 'timeout', id }
    }
}

const cancelPendingIdle = (): void => {
    if (!pendingIdle) return
    if (pendingIdle.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(pendingIdle.id)
    } else {
        window.clearTimeout(pendingIdle.id)
    }
    pendingIdle = null
}

const scanQueue = (queue: Text[], index: VocabIndex, onChunkDone?: () => void): void => {
    const myEpoch = scanEpoch
    const tick = (deadline: IdleDeadline): void => {
        pendingIdle = null
        if (myEpoch !== scanEpoch) return // teardown happened — drop this scan
        let processedThisTick = 0
        while (queue.length > 0 && deadline.timeRemaining() > 4 && processedThisTick < SCAN_CHUNK_SIZE) {
            const node = queue.shift()
            if (!node || !node.isConnected) continue
            try {
                highlightTextNode(node, index)
            } catch {
                // Some sites mutate the DOM under us mid-iteration — swallow & continue.
            }
            processedThisTick++
        }
        if (queue.length > 0) {
            requestIdle(tick)
        } else if (onChunkDone) {
            onChunkDone()
        }
    }
    requestIdle(tick)
}

/**
 * Cancel any idle-scheduled scan currently waiting to run, and invalidate
 * any tick that's already mid-iteration. Called from observer teardown.
 */
export const cancelInFlightScans = (): void => {
    scanEpoch++
    cancelPendingIdle()
}

/**
 * Full-page scan. Use on initial page load.
 */
export const scanDocument = (index: VocabIndex): void => {
    if (index.size === 0) return
    const queue = collectTextNodes(document.body, MAX_TEXT_NODES)
    scanQueue(queue, index)
}

/**
 * Returns a teardown function. The observer watches `document.body` for
 * added subtrees, in-place text changes, and removals, then incrementally
 * highlights / prunes accordingly. Debounced so SPA route changes (which
 * often emit hundreds of mutations) coalesce into one pass.
 *
 * Takes a getter rather than a value so that the live-refresh fast path (a
 * description-only update that swaps `currentIndex`) doesn't have to tear
 * down and rebuild the observer — subsequent SPA mutations will see the
 * latest vocabulary at flush time.
 */
export const startMutationObserver = (getIndex: () => VocabIndex): (() => void) => {
    if (getIndex().size === 0) return () => undefined

    let pendingRoots: Set<Node> = new Set()
    let pendingTextChanges: Set<Text> = new Set()
    let sawRemoval = false
    let timer: number | null = null

    const flush = (): void => {
        const index = getIndex()
        const roots = Array.from(pendingRoots)
        const textChanges = Array.from(pendingTextChanges)
        const hadRemoval = sawRemoval
        pendingRoots = new Set()
        pendingTextChanges = new Set()
        sawRemoval = false
        timer = null

        // Removals leave stale ranges anchored on detached text nodes.
        // Sweep them out before processing additions so we don't waste
        // hit-test work on dead entries.
        if (hadRemoval) pruneDeadRanges()

        // In-place text edits (`characterData`): the existing ranges on
        // these nodes point into the *old* offsets and must be dropped
        // before re-scanning the new content.
        const queue: Text[] = []
        for (const node of textChanges) {
            if (!node.isConnected || shouldSkipNode(node)) continue
            dropRangesOnTextNode(node)
            queue.push(node)
        }

        // Newly-added subtrees: collect text nodes the usual way.
        for (const root of roots) {
            if (!root.isConnected) continue
            if (root.nodeType === Node.TEXT_NODE) {
                if (!shouldSkipNode(root)) queue.push(root as Text)
            } else {
                const nested = collectTextNodes(root, MAX_TEXT_NODES)
                for (const n of nested) queue.push(n)
            }
            if (queue.length >= MAX_TEXT_NODES) break
        }
        if (queue.length > 0) scanQueue(queue, index)
    }

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                m.addedNodes.forEach((n) => pendingRoots.add(n))
                if (m.removedNodes.length > 0) sawRemoval = true
            } else if (m.type === 'characterData') {
                if (m.target.nodeType === Node.TEXT_NODE) {
                    pendingTextChanges.add(m.target as Text)
                }
            }
        }
        if (pendingRoots.size === 0 && pendingTextChanges.size === 0 && !sawRemoval) return
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(flush, MUTATION_DEBOUNCE_MS)
    })

    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    return () => {
        observer.disconnect()
        if (timer !== null) window.clearTimeout(timer)
        pendingRoots.clear()
        pendingTextChanges.clear()
        sawRemoval = false
        cancelInFlightScans()
    }
}
