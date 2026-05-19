/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Compact Porter Stemmer (Porter, 1980).
 *
 * Used to fold inflected forms ("running", "studies") to a common stem
 * so vocabulary matches survive verb tense / plural / adverb variation.
 *
 * The output is NOT a real lemma — `studies` becomes `studi`, not `study`.
 * That is fine: we stem both sides (page word and stored vocab word) to the
 * same convention before comparing, so equivalence is preserved.
 *
 * Pure function, no allocations beyond the result string. Safe to call in a
 * tight loop over text nodes.
 *
 * Reference: https://tartarus.org/martin/PorterStemmer/
 */

const VOWELS = 'aeiou'

const isVowel = (s: string, i: number): boolean => {
    const c = s[i]
    if (VOWELS.indexOf(c) !== -1) return true
    if (c === 'y') return i === 0 ? false : !isVowel(s, i - 1)
    return false
}

// Measure m: count of vowel→consonant transitions.
const measure = (s: string): number => {
    let n = 0
    let prevVowel = false
    for (let i = 0; i < s.length; i++) {
        const v = isVowel(s, i)
        if (prevVowel && !v) n++
        prevVowel = v
    }
    return n
}

const containsVowel = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) if (isVowel(s, i)) return true
    return false
}

const endsWithDoubleConsonant = (s: string): boolean => {
    if (s.length < 2) return false
    const a = s[s.length - 1]
    const b = s[s.length - 2]
    return a === b && !isVowel(s, s.length - 1)
}

// CVC pattern at end, where the second C is not w/x/y.
const endsCvc = (s: string): boolean => {
    if (s.length < 3) return false
    const i = s.length - 1
    if (isVowel(s, i)) return false
    if (!isVowel(s, i - 1)) return false
    if (isVowel(s, i - 2)) return false
    const last = s[i]
    return last !== 'w' && last !== 'x' && last !== 'y'
}

const replaceSuffix = (word: string, suffix: string, replacement: string): string =>
    word.slice(0, word.length - suffix.length) + replacement

const step1a = (w: string): string => {
    if (w.endsWith('sses')) return replaceSuffix(w, 'sses', 'ss')
    if (w.endsWith('ies')) return replaceSuffix(w, 'ies', 'i')
    if (w.endsWith('ss')) return w
    if (w.endsWith('s')) return w.slice(0, -1)
    return w
}

const step1b = (w: string): string => {
    if (w.endsWith('eed')) {
        const stem = w.slice(0, -3)
        return measure(stem) > 0 ? stem + 'ee' : w
    }
    const tryStrip = (suffix: 'ed' | 'ing'): string | null => {
        if (!w.endsWith(suffix)) return null
        const stem = w.slice(0, -suffix.length)
        if (!containsVowel(stem)) return null
        return stem
    }
    const stem = tryStrip('ed') ?? tryStrip('ing')
    if (stem === null) return w

    if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) return stem + 'e'
    if (endsWithDoubleConsonant(stem)) {
        const last = stem[stem.length - 1]
        if (last !== 'l' && last !== 's' && last !== 'z') return stem.slice(0, -1)
        return stem
    }
    if (measure(stem) === 1 && endsCvc(stem)) return stem + 'e'
    return stem
}

const step1c = (w: string): string => {
    if (w.endsWith('y') && w.length > 1 && containsVowel(w.slice(0, -1))) {
        return w.slice(0, -1) + 'i'
    }
    return w
}

// Step 2 / 3 / 4 / 5 suffix tables.
// Each entry: [suffix, replacement, minMeasure].
const STEP2: Array<[string, string, number]> = [
    ['ational', 'ate', 0],
    ['tional', 'tion', 0],
    ['enci', 'ence', 0],
    ['anci', 'ance', 0],
    ['izer', 'ize', 0],
    ['abli', 'able', 0],
    ['alli', 'al', 0],
    ['entli', 'ent', 0],
    ['eli', 'e', 0],
    ['ousli', 'ous', 0],
    ['ization', 'ize', 0],
    ['ation', 'ate', 0],
    ['ator', 'ate', 0],
    ['alism', 'al', 0],
    ['iveness', 'ive', 0],
    ['fulness', 'ful', 0],
    ['ousness', 'ous', 0],
    ['aliti', 'al', 0],
    ['iviti', 'ive', 0],
    ['biliti', 'ble', 0],
]

const STEP3: Array<[string, string, number]> = [
    ['icate', 'ic', 0],
    ['ative', '', 0],
    ['alize', 'al', 0],
    ['iciti', 'ic', 0],
    ['ical', 'ic', 0],
    ['ful', '', 0],
    ['ness', '', 0],
]

const STEP4_SUFFIXES = [
    'al',
    'ance',
    'ence',
    'er',
    'ic',
    'able',
    'ible',
    'ant',
    'ement',
    'ment',
    'ent',
    'ou',
    'ism',
    'ate',
    'iti',
    'ous',
    'ive',
    'ize',
]

const applyTable = (w: string, table: Array<[string, string, number]>): string => {
    for (const [suffix, replacement] of table) {
        if (w.endsWith(suffix)) {
            const stem = w.slice(0, -suffix.length)
            if (measure(stem) > 0) return stem + replacement
            return w
        }
    }
    return w
}

const step4 = (w: string): string => {
    // 'ion' has the extra constraint of preceding s/t.
    if (w.endsWith('ion') && w.length > 3) {
        const stem = w.slice(0, -3)
        const lastOfStem = stem[stem.length - 1]
        if ((lastOfStem === 's' || lastOfStem === 't') && measure(stem) > 1) return stem
    }
    for (const suffix of STEP4_SUFFIXES) {
        if (w.endsWith(suffix)) {
            const stem = w.slice(0, -suffix.length)
            if (measure(stem) > 1) return stem
            return w
        }
    }
    return w
}

const step5 = (w: string): string => {
    if (w.endsWith('e')) {
        const stem = w.slice(0, -1)
        const m = measure(stem)
        if (m > 1) return stem
        if (m === 1 && !endsCvc(stem)) return stem
    }
    if (w.endsWith('ll') && measure(w) > 1) return w.slice(0, -1)
    return w
}

export const stem = (word: string): string => {
    if (word.length < 3) return word
    const w0 = word.toLowerCase()
    const w1 = step1a(w0)
    const w2 = step1b(w1)
    const w3 = step1c(w2)
    const w4 = applyTable(w3, STEP2)
    const w5 = applyTable(w4, STEP3)
    const w6 = step4(w5)
    const w7 = step5(w6)
    return w7
}
