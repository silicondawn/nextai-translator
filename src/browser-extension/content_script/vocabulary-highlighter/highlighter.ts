import { HIGHLIGHT_NAME, MIN_WORD_LENGTH, STYLE_ELEMENT_ID, WORD_REGEX } from './consts'
import { isMatch, VocabIndex } from './vocabStore'

// TypeScript 5.1's lib.dom.d.ts predates the CSS Custom Highlight API. Add
// the minimal ambient declarations we need — drop these once we move to
// TS 5.5+ which ships them in lib.dom natively.
declare class Highlight {
    constructor(...ranges: Range[])
    add(range: Range): void
    clear(): void
    has(range: Range): boolean
    delete(range: Range): boolean
    readonly size: number
}
type HighlightRegistry = { set(name: string, h: Highlight): HighlightRegistry; get(name: string): Highlight | undefined }
const cssRegistry: HighlightRegistry | undefined = (CSS as unknown as { highlights?: HighlightRegistry }).highlights

/**
 * Visual layer — CSS Custom Highlight API renderer.
 *
 * Previously this module wrapped each match in `<span class="…">`. That
 * worked but had two real costs:
 *   1. Inserting inline elements perturbed certain sites' layout (tight
 *      letter-spacing grids, custom font-rendering pipelines, frameworks
 *      whose reconciler treats foreign DOM as mutations to undo).
 *   2. React/Vue pages would diff-and-restore the inserted spans, kicking
 *      our highlights back off the page.
 *
 * The Custom Highlight API solves both. We register a Highlight named
 * `nextai-vocab-hl` populated with Range objects, then a single
 * `::highlight(...)` rule paints them. The page DOM is never modified —
 * the host page sees the same text nodes it always had.
 *
 * The trade-off is that there's no DOM target for hover/click any more.
 * `getHighlightAtPoint(x, y)` solves that by mapping a cursor position
 * back to one of the active ranges via `caretPositionFromPoint`.
 */

let highlight: Highlight | null = null
let stylesInjected = false

// word (original casing from page) -> list of ranges currently covering it.
// The tooltip reads this to know which word was hovered and to anchor the
// popup to a real screen rect via `range.getBoundingClientRect()`.
const wordRanges = new Map<string, Range[]>()

// Text nodes we've already scanned. Backed by a WeakSet so detached nodes
// can be garbage-collected; that means we re-init the set whenever
// `clearAllHighlights()` runs so a fresh full scan can re-process them.
let processedNodes: WeakSet<Text> = new WeakSet()

const supportsHighlightApi = (): boolean => cssRegistry !== undefined

const ensureStyleElement = (): void => {
    if (stylesInjected) return
    if (document.getElementById(STYLE_ELEMENT_ID)) {
        stylesInjected = true
        return
    }
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    style.textContent = `
        ::highlight(${HIGHLIGHT_NAME}) {
            background-color: rgba(255, 222, 89, 0.55);
            background-image: linear-gradient(
                rgba(255, 222, 89, 0.55),
                rgba(255, 222, 89, 0.55)
            );
            border-radius: 2px;
        }
    `
    document.documentElement.appendChild(style)
    stylesInjected = true
}

const ensureHighlight = (): Highlight | null => {
    if (highlight) return highlight
    if (!cssRegistry) {
        // eslint-disable-next-line no-console
        console.warn(
            '[vocab-highlight] CSS Custom Highlight API unavailable; highlights will not render. Requires Chrome 105+.'
        )
        return null
    }
    highlight = new Highlight()
    cssRegistry.set(HIGHLIGHT_NAME, highlight)
    return highlight
}

export const ensureStyles = (): void => {
    ensureStyleElement()
    ensureHighlight()
}

/**
 * Scan `node`'s text for matches and register one Range per match into the
 * Highlight. Returns the number of ranges added. Idempotent per text node
 * (we skip nodes we've already processed).
 */
export const highlightTextNode = (node: Text, index: VocabIndex): number => {
    const h = ensureHighlight()
    if (!h) return 0
    if (processedNodes.has(node)) return 0
    const text = node.nodeValue
    if (!text || text.length < MIN_WORD_LENGTH) {
        processedNodes.add(node)
        return 0
    }

    WORD_REGEX.lastIndex = 0
    let count = 0
    for (const m of text.matchAll(WORD_REGEX)) {
        const word = m[0]
        if (word.length < MIN_WORD_LENGTH) continue
        if (!isMatch(index, word)) continue
        const range = new Range()
        range.setStart(node, m.index!)
        range.setEnd(node, m.index! + word.length)
        h.add(range)
        const bucket = wordRanges.get(word) ?? []
        bucket.push(range)
        wordRanges.set(word, bucket)
        count++
    }
    processedNodes.add(node)
    return count
}

/**
 * Drop every range we've added and reset the processed-node cache so the
 * next scan starts from scratch. Used by the slow-path live refresh.
 */
export const clearAllHighlights = (): void => {
    if (highlight) highlight.clear()
    wordRanges.clear()
    processedNodes = new WeakSet()
}

/**
 * Drop all ranges anchored on `node` and forget that we've processed it,
 * so a subsequent `highlightTextNode` call can re-scan it. Used when a
 * MutationObserver characterData record tells us the text contents have
 * changed under our feet — the old offsets are no longer meaningful.
 */
export const dropRangesOnTextNode = (node: Text): void => {
    if (!highlight) return
    let touched = false
    for (const [word, bucket] of wordRanges) {
        let dropped = 0
        const live: Range[] = []
        for (const r of bucket) {
            if (r.startContainer === node) {
                highlight.delete(r)
                dropped++
            } else {
                live.push(r)
            }
        }
        if (dropped === 0) continue
        touched = true
        if (live.length === 0) wordRanges.delete(word)
        else wordRanges.set(word, live)
    }
    if (touched) processedNodes.delete(node)
}

/**
 * Walk the in-memory range index and drop any range whose anchor text node
 * has been detached from the document. Called from the MutationObserver
 * flush — handling `removedNodes` proactively this way avoids paying for a
 * subtree walk on every removal and is robust even when a SPA blows away
 * a whole pane.
 */
export const pruneDeadRanges = (): void => {
    if (!highlight) return
    for (const [word, bucket] of wordRanges) {
        let pruned = 0
        const live: Range[] = []
        for (const r of bucket) {
            if (r.startContainer.isConnected) {
                live.push(r)
            } else {
                highlight.delete(r)
                pruned++
            }
        }
        if (pruned === 0) continue
        if (live.length === 0) wordRanges.delete(word)
        else wordRanges.set(word, live)
    }
}

/**
 * Map a viewport point to one of our highlighted ranges, if any.
 *
 * Used by the tooltip's hover and click handlers in lieu of the
 * mouseover-on-span pattern. Pre-filter by bounding rect to keep the
 * comparePoint loop bounded — typical pages have a few dozen highlights
 * but pathological cases can have hundreds.
 */
export interface HighlightHit {
    word: string
    range: Range
}

export const getHighlightAtPoint = (x: number, y: number): HighlightHit | null => {
    if (wordRanges.size === 0) return null

    let caretNode: Node | null = null
    let caretOffset = 0
    const docAny = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    if (typeof docAny.caretPositionFromPoint === 'function') {
        const pos = docAny.caretPositionFromPoint(x, y)
        if (pos) {
            caretNode = pos.offsetNode
            caretOffset = pos.offset
        }
    } else if (typeof docAny.caretRangeFromPoint === 'function') {
        const r = docAny.caretRangeFromPoint(x, y)
        if (r) {
            caretNode = r.startContainer
            caretOffset = r.startOffset
        }
    }
    if (!caretNode) return null

    for (const [word, ranges] of wordRanges) {
        for (const range of ranges) {
            let rect: DOMRect
            try {
                rect = range.getBoundingClientRect()
            } catch {
                continue
            }
            if (rect.width === 0 && rect.height === 0) continue
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
            try {
                if (range.comparePoint(caretNode, caretOffset) === 0) {
                    return { word, range }
                }
            } catch {
                // Detached node — stale range from a DOM mutation. Skip.
            }
        }
    }
    return null
}
