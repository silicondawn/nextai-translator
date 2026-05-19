import { describe, expect, it } from 'vitest'
import { stem } from '../stemmer'

describe('stem', () => {
    it('passes through short words', () => {
        expect(stem('a')).toBe('a')
        expect(stem('is')).toBe('is')
    })

    it('lowercases input', () => {
        expect(stem('CARES')).toBe(stem('cares'))
    })

    // Pairs that MUST collapse to the same stem — this is the property the
    // highlighter relies on. We do not assert the stem value itself
    // (Porter is famously lossy — `studies` → `studi`, not `study`); we only
    // care that both sides land at the same key.
    const equivalencePairs: ReadonlyArray<readonly [string, string]> = [
        ['run', 'running'],
        ['cat', 'cats'],
        ['study', 'studies'],
        ['agree', 'agreed'],
        ['relate', 'relational'],
        ['observe', 'observing'],
        ['national', 'nation'],
    ]

    it.each(equivalencePairs)('treats "%s" and "%s" as equivalent', (a, b) => {
        expect(stem(a)).toBe(stem(b))
    })

    // Known Porter (1980) gaps. We document them rather than pretend they
    // pass — these are the canonical motivation for upgrading to Porter2 /
    // wink-lemmatizer / LLM-generated inflections (see module README).
    const knownGaps: ReadonlyArray<readonly [string, string]> = [['happy', 'happily']]
    it.each(knownGaps)('KNOWN GAP: "%s" and "%s" do not yet collapse', (a, b) => {
        expect(stem(a)).not.toBe(stem(b))
    })

    it('keeps clearly different words apart', () => {
        expect(stem('cat')).not.toBe(stem('dog'))
        expect(stem('happy')).not.toBe(stem('sad'))
    })

    it('is idempotent — stem(stem(x)) === stem(x)', () => {
        for (const w of ['running', 'studies', 'nationalization', 'happily', 'tables']) {
            expect(stem(stem(w))).toBe(stem(w))
        }
    })
})
