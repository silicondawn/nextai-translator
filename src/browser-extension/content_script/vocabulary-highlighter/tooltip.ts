import {
    HOVER_HIDE_DELAY_MS,
    HOVER_SHOW_DELAY_MS,
    MOUSEMOVE_THROTTLE_MS,
    TOOLTIP_ELEMENT_ID,
    TOOLTIP_GAP_PX,
    TOOLTIP_STYLE_ELEMENT_ID,
    TOOLTIP_VIEWPORT_PADDING_PX,
} from './consts'
import { getHighlightAtPoint, HighlightHit } from './highlighter'
import { lookupDescription, VocabIndex } from './vocabStore'

/**
 * Hover tooltip layer.
 *
 * Design choices:
 *   - Singleton DOM element (id `nextai-vocab-hl-tooltip`) shared by every
 *     highlight on the page. Hovering between adjacent highlights reuses
 *     the same element, avoiding flicker and DOM churn.
 *   - Hit-testing via `getHighlightAtPoint` (caretPositionFromPoint +
 *     Range.comparePoint). The page DOM has no span anchors any more — the
 *     Custom Highlight API renderer paints highlights as pure pseudo
 *     overlays. mousemove is throttled to ~32ms so the bookkeeping cost
 *     stays small even on pages with hundreds of highlighted words.
 *   - 150ms show-delay so passing the cursor across text doesn't flash a
 *     tooltip on every word. 200ms hide-delay lets the cursor travel from
 *     the anchor word onto the tooltip without it disappearing mid-flight;
 *     mouseenter on the tooltip cancels the pending hide so the user can
 *     hover over its body and read freely. Moving away resumes the hide.
 *   - Click on a highlighted range calls the injected `onActivate` callback
 *     (wired in `content_script/index.tsx` to `showPopupCard`). The tooltip
 *     itself stays UI-only — it does not import the heavy translator code.
 */

export interface MountTooltipOptions {
    // Live getter rather than a value: lets live-refresh swap the underlying
    // index (e.g. as a streaming translation fills in the description) without
    // tearing down the tooltip element or its listeners.
    getIndex: () => VocabIndex
    // `anchor` is anything with getBoundingClientRect — typically a Range now
    // that we use the Highlight API. Compatible with @floating-ui/dom's
    // ReferenceElement so callers can hand it straight to showPopupCard.
    onActivate?: (word: string, anchor: { getBoundingClientRect: () => DOMRect }) => void
}

interface TooltipState {
    element: HTMLDivElement
    showTimer: number | null
    hideTimer: number | null
    currentHit: HighlightHit | null
    mousemoveLastAt: number
}

let state: TooltipState | null = null
let activeGetIndex: (() => VocabIndex) | null = null

const ensureTooltipStyles = (): void => {
    if (document.getElementById(TOOLTIP_STYLE_ELEMENT_ID)) return
    const style = document.createElement('style')
    style.id = TOOLTIP_STYLE_ELEMENT_ID
    style.textContent = `
        #${TOOLTIP_ELEMENT_ID} {
            position: fixed !important;
            z-index: 2147483646 !important;
            max-width: 360px !important;
            min-width: 200px !important;
            max-height: 60vh !important;
            padding: 10px 14px !important;
            background-color: #ffffff !important;
            color: #1a1a1a !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                'Helvetica Neue', Arial, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.5 !important;
            border: 1px solid rgba(0, 0, 0, 0.08) !important;
            border-radius: 6px !important;
            box-shadow:
                0 2px 8px rgba(0, 0, 0, 0.08),
                0 4px 24px rgba(0, 0, 0, 0.12) !important;
            opacity: 0 !important;
            transition: opacity 80ms ease-out !important;
            pointer-events: auto !important;
            white-space: pre-wrap !important;
            word-break: break-word !important;
            overflow-wrap: anywhere !important;
            overflow: hidden !important;
            visibility: hidden !important;
        }
        #${TOOLTIP_ELEMENT_ID}[data-visible='true'] {
            opacity: 1 !important;
            visibility: visible !important;
        }
        #${TOOLTIP_ELEMENT_ID} strong {
            font-weight: 600 !important;
        }
        #${TOOLTIP_ELEMENT_ID} code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace !important;
            font-size: 0.92em !important;
            background-color: rgba(0, 0, 0, 0.06) !important;
            padding: 0 4px !important;
            border-radius: 3px !important;
        }
        @media (prefers-color-scheme: dark) {
            #${TOOLTIP_ELEMENT_ID} {
                background-color: #2a2a2a !important;
                color: #f0f0f0 !important;
                border-color: rgba(255, 255, 255, 0.1) !important;
            }
            #${TOOLTIP_ELEMENT_ID} code {
                background-color: rgba(255, 255, 255, 0.08) !important;
            }
        }
    `
    document.documentElement.appendChild(style)
}

const ensureTooltipElement = (): HTMLDivElement => {
    const existing = document.getElementById(TOOLTIP_ELEMENT_ID) as HTMLDivElement | null
    if (existing) return existing
    const el = document.createElement('div')
    el.id = TOOLTIP_ELEMENT_ID
    el.setAttribute('role', 'tooltip')
    el.setAttribute('aria-hidden', 'true')
    document.body.appendChild(el)
    return el
}

const positionTooltip = (tooltip: HTMLElement, anchorRect: DOMRect): void => {
    // Reset to top-left so width/height measurements aren't clipped by viewport edges.
    tooltip.style.left = '0px'
    tooltip.style.top = '0px'

    const tipRect = tooltip.getBoundingClientRect()
    const tipW = tipRect.width
    const tipH = tipRect.height
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pad = TOOLTIP_VIEWPORT_PADDING_PX
    const gap = TOOLTIP_GAP_PX

    // Horizontal: centred on anchor, clamped to viewport.
    let left = anchorRect.left + anchorRect.width / 2 - tipW / 2
    left = Math.max(pad, Math.min(left, vw - tipW - pad))

    const spaceAbove = anchorRect.top
    const spaceBelow = vh - anchorRect.bottom
    const needed = tipH + gap + pad
    let top: number
    if (spaceAbove >= needed) {
        top = anchorRect.top - tipH - gap
    } else if (spaceBelow >= needed) {
        top = anchorRect.bottom + gap
    } else {
        if (tipH + 2 * pad > vh) {
            top = pad
        } else {
            top = Math.max(pad, vh - tipH - pad)
        }
    }

    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
}

// Shown while the background translation is still streaming. A highlighted
// word that lacks a description means it was silent-saved very recently;
// the next vocabUpdated broadcast will refresh the index with the real text.
const PENDING_PLACEHOLDER = '翻译中…'

// Minimal markdown -> HTML renderer.
//
// Translator output uses **bold** liberally (the saved word, parts of
// speech, phonetic labels) and occasional `inline code`. Everything else
// (line breaks, paragraph layout) is already handled by `white-space:
// pre-wrap` in the tooltip stylesheet, so we don't need a full markdown
// engine — react-markdown plus React would dwarf the rest of the module.
//
// All input is HTML-escaped before any tag substitution: descriptions
// originate from the user's own LLM provider, but the cost of being
// defensive here is one regex pass.
const HTML_ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c] ?? c)

const renderInlineMarkdown = (raw: string): string =>
    escapeHtml(raw)
        .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')

const renderContentFor = (word: string, index: VocabIndex): void => {
    if (!state) return
    const description = lookupDescription(index, word)
    if (description && description.length > 0) {
        state.element.innerHTML = renderInlineMarkdown(description)
    } else {
        state.element.textContent = PENDING_PLACEHOLDER
    }
}

const showFor = (hit: HighlightHit, index: VocabIndex): void => {
    if (!state) return
    renderContentFor(hit.word, index)
    state.element.setAttribute('aria-hidden', 'false')
    positionTooltip(state.element, hit.range.getBoundingClientRect())
    state.element.dataset['visible'] = 'true'
    state.currentHit = hit
}

/**
 * Re-render the tooltip's text and reposition (height may change) using the
 * live vocab index. Called by the live-refresh fast path so a streaming
 * description appears as it arrives, without disrupting the hover state.
 */
export const refreshTooltipContent = (): void => {
    if (!state || !state.currentHit) return
    const { word, range } = state.currentHit
    if (!range.commonAncestorContainer.isConnected) {
        hide()
        return
    }
    const index = activeGetIndex?.()
    if (!index) return
    renderContentFor(word, index)
    positionTooltip(state.element, range.getBoundingClientRect())
}

const hide = (): void => {
    if (!state) return
    if (state.showTimer !== null) {
        window.clearTimeout(state.showTimer)
        state.showTimer = null
    }
    if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer)
        state.hideTimer = null
    }
    state.element.dataset['visible'] = 'false'
    state.element.setAttribute('aria-hidden', 'true')
    state.currentHit = null
}

const cancelHide = (): void => {
    if (!state) return
    if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer)
        state.hideTimer = null
    }
}

const scheduleHide = (): void => {
    if (!state) return
    if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
    state.hideTimer = window.setTimeout(() => {
        if (state) state.hideTimer = null
        hide()
    }, HOVER_HIDE_DELAY_MS)
}

export const mountTooltip = (opts: MountTooltipOptions): (() => void) => {
    ensureTooltipStyles()
    const element = ensureTooltipElement()
    state = { element, showTimer: null, hideTimer: null, currentHit: null, mousemoveLastAt: 0 }
    activeGetIndex = opts.getIndex

    const handleMousemove = (e: MouseEvent): void => {
        if (!state) return

        // Throttle — caret-position lookups + range hit-tests are cheap but
        // mousemove fires per-pixel; 32ms keeps the per-second budget bounded.
        const now = Date.now()
        if (now - state.mousemoveLastAt < MOUSEMOVE_THROTTLE_MS) return
        state.mousemoveLastAt = now

        // Cursor over the tooltip itself — let its own mouseenter/leave
        // handlers govern the hide schedule.
        if (e.target instanceof Node && state.element.contains(e.target)) {
            cancelHide()
            return
        }

        const hit = getHighlightAtPoint(e.clientX, e.clientY)
        if (!hit) {
            if (state.currentHit || state.showTimer !== null) {
                if (state.showTimer !== null) {
                    window.clearTimeout(state.showTimer)
                    state.showTimer = null
                }
                if (state.currentHit) scheduleHide()
            }
            return
        }

        // We're on a highlight — cancel any queued hide.
        cancelHide()

        // Same range, nothing to do (avoid restarting the show delay).
        if (state.currentHit && hit.range === state.currentHit.range) return

        // New / different highlight: clear stale tooltip, queue a fresh show.
        if (state.showTimer !== null) window.clearTimeout(state.showTimer)
        if (state.currentHit) {
            state.element.dataset['visible'] = 'false'
            state.currentHit = null
        }
        state.showTimer = window.setTimeout(() => {
            showFor(hit, opts.getIndex())
            if (state) state.showTimer = null
        }, HOVER_SHOW_DELAY_MS)
    }

    const handleClick = (e: MouseEvent): void => {
        if (!state || !opts.onActivate) return
        // If the click landed inside the tooltip, leave it to its own
        // listeners (no activation; tooltip body is informational only).
        if (e.target instanceof Node && state.element.contains(e.target)) return
        const hit = getHighlightAtPoint(e.clientX, e.clientY)
        if (!hit) return
        hide()
        try {
            // Range satisfies @floating-ui/dom's ReferenceElement shape, so
            // showPopupCard can use it directly as the anchor.
            opts.onActivate(hit.word, hit.range)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[vocab-highlight] onActivate failed', err)
        }
    }

    const handleTooltipEnter = (): void => {
        cancelHide()
    }

    const handleTooltipLeave = (e: MouseEvent): void => {
        if (!state) return
        // If the cursor leaves the tooltip back onto its current anchor
        // range, the next mousemove tick will cancel the hide; we still
        // schedule it here so plain "drift onto blank page" still dismisses.
        void e
        scheduleHide()
    }

    const handleScrollOrResize = (): void => {
        // Bounding rects move under scroll; hiding matches Chrome's own
        // tooltip behaviour and is much cheaper than reanchoring.
        if (state?.currentHit) hide()
    }

    document.addEventListener('mousemove', handleMousemove, true)
    document.addEventListener('click', handleClick, true)
    element.addEventListener('mouseenter', handleTooltipEnter)
    element.addEventListener('mouseleave', handleTooltipLeave)
    window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true })
    window.addEventListener('resize', handleScrollOrResize)

    return () => {
        document.removeEventListener('mousemove', handleMousemove, true)
        document.removeEventListener('click', handleClick, true)
        element.removeEventListener('mouseenter', handleTooltipEnter)
        element.removeEventListener('mouseleave', handleTooltipLeave)
        window.removeEventListener('scroll', handleScrollOrResize, true)
        window.removeEventListener('resize', handleScrollOrResize)
        if (state) {
            if (state.showTimer !== null) window.clearTimeout(state.showTimer)
            if (state.hideTimer !== null) window.clearTimeout(state.hideTimer)
            state.element.remove()
            state = null
        }
        activeGetIndex = null
        document.getElementById(TOOLTIP_STYLE_ELEMENT_ID)?.remove()
    }
}
