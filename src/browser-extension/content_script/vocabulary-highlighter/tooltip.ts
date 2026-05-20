import {
    DATA_ATTR_ORIGINAL,
    HIGHLIGHT_CLASS,
    HOVER_SHOW_DELAY_MS,
    TOOLTIP_ELEMENT_ID,
    TOOLTIP_GAP_PX,
    TOOLTIP_STYLE_ELEMENT_ID,
    TOOLTIP_VIEWPORT_PADDING_PX,
} from './consts'
import { lookupDescription, VocabIndex } from './vocabStore'

/**
 * Hover tooltip layer.
 *
 * Design choices:
 *   - Singleton DOM element (id `nextai-vocab-hl-tooltip`) shared by every
 *     highlight on the page. Hovering between adjacent highlights reuses
 *     the same element, avoiding flicker and DOM churn.
 *   - Event delegation on `document` (capture phase) — never bind listeners
 *     to individual span elements. Survives DOM rewrites by SPAs.
 *   - 150ms show-delay so passing the cursor across text doesn't flash a
 *     tooltip on every word. Instant hide on mouseleave — line-clamped 3
 *     lines is small enough that users either read it in place or click to
 *     open the full translator card.
 *   - Click on a highlighted span calls the injected `onActivate` callback
 *     (wired in `content_script/index.tsx` to `showPopupCard`). The tooltip
 *     itself stays UI-only — it does not import the heavy translator code.
 */

export interface MountTooltipOptions {
    index: VocabIndex
    onActivate?: (word: string, anchor: HTMLElement) => void
}

interface TooltipState {
    element: HTMLDivElement
    showTimer: number | null
    currentTarget: HTMLElement | null
}

let state: TooltipState | null = null

const ensureTooltipStyles = (): void => {
    if (document.getElementById(TOOLTIP_STYLE_ELEMENT_ID)) return
    const style = document.createElement('style')
    style.id = TOOLTIP_STYLE_ELEMENT_ID
    // All declarations are !important to survive aggressive site CSS resets.
    // The tooltip is intentionally simple — no animations beyond a brief fade,
    // no arrow, no shadow DOM (keeps the bundle small; the existing
    // highlighter.ts uses the same plain-style-tag pattern).
    style.textContent = `
        #${TOOLTIP_ELEMENT_ID} {
            position: fixed !important;
            z-index: 2147483646 !important;
            max-width: 280px !important;
            padding: 8px 12px !important;
            background-color: #ffffff !important;
            color: #1a1a1a !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                'Helvetica Neue', Arial, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.45 !important;
            border: 1px solid rgba(0, 0, 0, 0.08) !important;
            border-radius: 6px !important;
            box-shadow:
                0 2px 8px rgba(0, 0, 0, 0.08),
                0 4px 24px rgba(0, 0, 0, 0.12) !important;
            opacity: 0 !important;
            transition: opacity 80ms ease-out !important;
            pointer-events: none !important;
            display: -webkit-box !important;
            -webkit-line-clamp: 3 !important;
            -webkit-box-orient: vertical !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: normal !important;
            word-break: break-word !important;
            visibility: hidden !important;
        }
        #${TOOLTIP_ELEMENT_ID}[data-visible='true'] {
            opacity: 1 !important;
            visibility: visible !important;
        }
        @media (prefers-color-scheme: dark) {
            #${TOOLTIP_ELEMENT_ID} {
                background-color: #2a2a2a !important;
                color: #f0f0f0 !important;
                border-color: rgba(255, 255, 255, 0.1) !important;
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

const positionTooltip = (tooltip: HTMLElement, anchor: HTMLElement): void => {
    // Reset to top-left so width/height measurements aren't clipped by viewport edges.
    tooltip.style.left = '0px'
    tooltip.style.top = '0px'

    const anchorRect = anchor.getBoundingClientRect()
    const tipRect = tooltip.getBoundingClientRect()
    const tipW = tipRect.width
    const tipH = tipRect.height

    // Horizontal: centred on anchor, clamped to viewport with 8px gutter.
    let left = anchorRect.left + anchorRect.width / 2 - tipW / 2
    const maxLeft = window.innerWidth - tipW - TOOLTIP_VIEWPORT_PADDING_PX
    left = Math.max(TOOLTIP_VIEWPORT_PADDING_PX, Math.min(left, maxLeft))

    // Vertical: above by default, flip below if not enough room.
    const spaceAbove = anchorRect.top
    const needed = tipH + TOOLTIP_GAP_PX + TOOLTIP_VIEWPORT_PADDING_PX
    const top = spaceAbove >= needed ? anchorRect.top - tipH - TOOLTIP_GAP_PX : anchorRect.bottom + TOOLTIP_GAP_PX

    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
}

const findHighlightTarget = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof HTMLElement)) return null
    if (node.classList.contains(HIGHLIGHT_CLASS)) return node
    return null
}

const wordOf = (target: HTMLElement): string => {
    return target.getAttribute(DATA_ATTR_ORIGINAL) ?? target.textContent ?? ''
}

const showFor = (target: HTMLElement, index: VocabIndex): void => {
    if (!state) return
    const description = lookupDescription(index, wordOf(target))
    if (!description) return
    state.element.textContent = description
    state.element.setAttribute('aria-hidden', 'false')
    positionTooltip(state.element, target)
    state.element.dataset['visible'] = 'true'
    state.currentTarget = target
}

const hide = (): void => {
    if (!state) return
    if (state.showTimer !== null) {
        window.clearTimeout(state.showTimer)
        state.showTimer = null
    }
    state.element.dataset['visible'] = 'false'
    state.element.setAttribute('aria-hidden', 'true')
    state.currentTarget = null
}

export const mountTooltip = (opts: MountTooltipOptions): (() => void) => {
    ensureTooltipStyles()
    const element = ensureTooltipElement()
    state = { element, showTimer: null, currentTarget: null }

    const handleOver = (e: MouseEvent): void => {
        const target = findHighlightTarget(e.target)
        if (!target || !state) return
        if (target === state.currentTarget) return
        if (state.showTimer !== null) window.clearTimeout(state.showTimer)
        // Clear stale tooltip immediately so a fast hop between two
        // highlights doesn't briefly show the previous description.
        if (state.currentTarget) {
            state.element.dataset['visible'] = 'false'
            state.currentTarget = null
        }
        state.showTimer = window.setTimeout(() => {
            showFor(target, opts.index)
            if (state) state.showTimer = null
        }, HOVER_SHOW_DELAY_MS)
    }

    const handleOut = (e: MouseEvent): void => {
        const target = findHighlightTarget(e.target)
        if (!target) return
        // mouseout fires while moving to a descendant — guard against that
        // (highlight spans have no element children today, but defensive).
        const next = e.relatedTarget
        if (next instanceof Node && target.contains(next)) return
        hide()
    }

    const handleClick = (e: MouseEvent): void => {
        const target = findHighlightTarget(e.target)
        if (!target || !opts.onActivate) return
        const word = wordOf(target)
        if (!word) return
        hide()
        try {
            opts.onActivate(word, target)
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[vocab-highlight] onActivate failed', err)
        }
    }

    const handleScrollOrResize = (): void => {
        // Reanchoring on scroll would jitter; hiding matches Chrome's own
        // tooltip behaviour and is much cheaper.
        if (state?.currentTarget) hide()
    }

    // Capture phase so we still see events on pages that stopPropagation in
    // their own bubble handlers (common on Twitter, Notion, etc.).
    document.addEventListener('mouseover', handleOver, true)
    document.addEventListener('mouseout', handleOut, true)
    document.addEventListener('click', handleClick, true)
    window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true })
    window.addEventListener('resize', handleScrollOrResize)

    return () => {
        document.removeEventListener('mouseover', handleOver, true)
        document.removeEventListener('mouseout', handleOut, true)
        document.removeEventListener('click', handleClick, true)
        window.removeEventListener('scroll', handleScrollOrResize, true)
        window.removeEventListener('resize', handleScrollOrResize)
        if (state) {
            if (state.showTimer !== null) window.clearTimeout(state.showTimer)
            state.element.remove()
            state = null
        }
        document.getElementById(TOOLTIP_STYLE_ELEMENT_ID)?.remove()
    }
}
