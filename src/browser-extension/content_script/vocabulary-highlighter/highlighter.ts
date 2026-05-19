import { DATA_ATTR_ORIGINAL, HIGHLIGHT_CLASS, MIN_WORD_LENGTH, STYLE_ELEMENT_ID, WORD_REGEX } from './consts'
import { isMatch, VocabIndex } from './vocabStore'

/**
 * Visual layer: takes a text node + a vocab index, replaces matched words
 * with `<span class="nextai-vocab-hl">…</span>` in-place.
 *
 * Trade-off note: we use span-wrapping (and not the CSS Custom Highlight API)
 * deliberately for MVP. Wrapping survives clipboard copy as plain text, lets
 * us attach hover handlers directly, and works on every Chrome version.
 * Cost: extra DOM nodes, occasional layout shifts on highly dynamic pages.
 * v2 may swap this for `CSS.highlights.set()` once the hover/click UX lands.
 */

let stylesInjected = false

const injectStyles = (): void => {
    if (stylesInjected) return
    if (document.getElementById(STYLE_ELEMENT_ID)) {
        stylesInjected = true
        return
    }
    const style = document.createElement('style')
    style.id = STYLE_ELEMENT_ID
    // !important on background only — keep typography untouched to avoid
    // reflows on sites with strict typographic grids.
    style.textContent = `
        .${HIGHLIGHT_CLASS} {
            background-color: rgba(255, 222, 89, 0.55) !important;
            background-image: linear-gradient(
                rgba(255, 222, 89, 0.55),
                rgba(255, 222, 89, 0.55)
            ) !important;
            border-radius: 2px !important;
            padding: 0 1px !important;
            box-decoration-break: clone;
            -webkit-box-decoration-break: clone;
            cursor: help;
        }
    `
    document.documentElement.appendChild(style)
    stylesInjected = true
}

/**
 * Splits a text node into [plain | <span> | plain | <span> | ...] pieces
 * based on matches against the vocab index.
 *
 * Returns the number of highlights produced. Returns 0 (and leaves the node
 * untouched) if there are no matches — important: do NOT replace nodes
 * unnecessarily, that triggers expensive site-level mutation handlers
 * on React/Vue pages.
 */
export const highlightTextNode = (node: Text, index: VocabIndex): number => {
    const text = node.nodeValue
    if (!text) return 0
    if (text.length < MIN_WORD_LENGTH) return 0

    WORD_REGEX.lastIndex = 0
    const matches: Array<{ start: number; end: number; word: string }> = []
    for (const m of text.matchAll(WORD_REGEX)) {
        const word = m[0]
        if (word.length < MIN_WORD_LENGTH) continue
        if (!isMatch(index, word)) continue
        matches.push({ start: m.index!, end: m.index! + word.length, word })
    }
    if (matches.length === 0) return 0

    const parent = node.parentNode
    if (!parent) return 0

    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const m of matches) {
        if (m.start > cursor) {
            frag.appendChild(document.createTextNode(text.slice(cursor, m.start)))
        }
        const span = document.createElement('span')
        span.className = HIGHLIGHT_CLASS
        span.setAttribute(DATA_ATTR_ORIGINAL, m.word)
        span.textContent = m.word
        frag.appendChild(span)
        cursor = m.end
    }
    if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)))
    }
    parent.replaceChild(frag, node)
    return matches.length
}

export const ensureStyles = (): void => injectStyles()

/**
 * Removes all highlights inserted by this module — used when the user
 * disables the feature mid-session. Restores original text nodes so the
 * page is exactly as it was before.
 */
export const clearAllHighlights = (root: ParentNode = document): void => {
    const spans = root.querySelectorAll<HTMLElement>(`span.${HIGHLIGHT_CLASS}`)
    spans.forEach((span) => {
        const parent = span.parentNode
        if (!parent) return
        parent.replaceChild(document.createTextNode(span.textContent ?? ''), span)
        // Merge adjacent text nodes that the unwrap creates.
        parent.normalize()
    })
}
