import { popupCardID, popupThumbID } from '../consts'
import {
    HIGHLIGHT_CLASS,
    MAX_TEXT_NODES,
    MUTATION_DEBOUNCE_MS,
    SCAN_CHUNK_SIZE,
    TOOLTIP_ELEMENT_ID,
} from './consts'
import { highlightTextNode } from './highlighter'
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
            // Our own previously-inserted spans — leave them alone.
            if (el.classList && el.classList.contains(HIGHLIGHT_CLASS)) return true
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

const requestIdle = (cb: (deadline: IdleDeadline) => void): number => {
    if (typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(cb, { timeout: 1000 })
    }
    // Safari fallback (Tauri/Safari builds).
    return window.setTimeout(() => cb({ timeRemaining: () => 16, didTimeout: false } as IdleDeadline), 16)
}

const scanQueue = (queue: Text[], index: VocabIndex, onChunkDone?: () => void): void => {
    const tick = (deadline: IdleDeadline): void => {
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
 * Full-page scan. Use on initial page load.
 */
export const scanDocument = (index: VocabIndex): void => {
    if (index.size === 0) return
    const queue = collectTextNodes(document.body, MAX_TEXT_NODES)
    scanQueue(queue, index)
}

/**
 * Returns a teardown function. The observer watches `document.body` for
 * added subtrees and incrementally highlights them. Debounced so SPA route
 * changes (which often emit hundreds of mutations) coalesce into one pass.
 *
 * Takes a getter rather than a value so that the live-refresh fast path (a
 * description-only update that swaps `currentIndex`) doesn't have to tear
 * down and rebuild the observer — subsequent SPA mutations will see the
 * latest vocabulary at flush time.
 */
export const startMutationObserver = (getIndex: () => VocabIndex): (() => void) => {
    if (getIndex().size === 0) return () => undefined

    let pending: Set<Node> = new Set()
    let timer: number | null = null

    const flush = (): void => {
        const index = getIndex()
        const roots = Array.from(pending)
        pending = new Set()
        timer = null
        const queue: Text[] = []
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
            if (m.type !== 'childList') continue
            m.addedNodes.forEach((n) => pending.add(n))
        }
        if (pending.size === 0) return
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(flush, MUTATION_DEBOUNCE_MS)
    })

    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
        observer.disconnect()
        if (timer !== null) window.clearTimeout(timer)
        pending.clear()
    }
}
