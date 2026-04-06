import { describe, expect, it } from 'vitest'

import {
  parseSrtTimestamp,
  parseSrtCues,
  parseWhisperJsonWords,
  parseWhisperJsonCues,
  shouldRetryWhisperWithoutJson,
  buildCaptionTextFromWords,
} from './captionParsing'

describe('parseSrtTimestamp', () => {
  it('parses a valid SRT timestamp', () => {
    expect(parseSrtTimestamp('00:01:23,456')).toBe(83456)
  })

  it('parses zero timestamp', () => {
    expect(parseSrtTimestamp('00:00:00,000')).toBe(0)
  })

  it('handles leading/trailing whitespace', () => {
    expect(parseSrtTimestamp('  00:00:05,200  ')).toBe(5200)
  })

  it('returns null for invalid format', () => {
    expect(parseSrtTimestamp('00:00:05.200')).toBeNull()
    expect(parseSrtTimestamp('not a timestamp')).toBeNull()
    expect(parseSrtTimestamp('')).toBeNull()
  })
})

describe('parseSrtCues', () => {
  it('parses a standard SRT file', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'Hello world',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,500',
      'Second line',
    ].join('\n')

    const cues = parseSrtCues(srt)
    expect(cues).toEqual([
      { id: 'caption-1', startMs: 1000, endMs: 3000, text: 'Hello world' },
      { id: 'caption-2', startMs: 4000, endMs: 6500, text: 'Second line' },
    ])
  })

  it('skips blocks with no timing line', () => {
    const srt = [
      'no timing here',
      '',
      '1',
      '00:00:01,000 --> 00:00:02,000',
      'Valid cue',
    ].join('\n')

    const cues = parseSrtCues(srt)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Valid cue')
  })

  it('skips cues where end <= start', () => {
    const srt = [
      '1',
      '00:00:05,000 --> 00:00:05,000',
      'Same start and end',
      '',
      '2',
      '00:00:06,000 --> 00:00:04,000',
      'End before start',
    ].join('\n')

    expect(parseSrtCues(srt)).toEqual([])
  })

  it('skips cues with empty text', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '',
    ].join('\n')

    expect(parseSrtCues(srt)).toEqual([])
  })

  it('handles multiline cue text', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,000',
      'Line one',
      'Line two',
    ].join('\n')

    const cues = parseSrtCues(srt)
    expect(cues[0].text).toBe('Line one\nLine two')
  })

  it('returns empty array for empty input', () => {
    expect(parseSrtCues('')).toEqual([])
  })
})

describe('parseWhisperJsonWords', () => {
  it('parses valid tokens into words', () => {
    const tokens = [
      { text: 'Hello', offsets: { from: 0, to: 500 } },
      { text: ' world', offsets: { from: 500, to: 1000 } },
    ]

    const words = parseWhisperJsonWords(tokens)
    expect(words).toEqual([
      { text: 'Hello', startMs: 0, endMs: 500 },
      { text: 'world', startMs: 500, endMs: 1000, leadingSpace: true },
    ])
  })

  it('skips tokens with invalid timing but keeps valid ones', () => {
    const tokens = [
      { text: 'good', offsets: { from: 0, to: 500 } },
      { text: ' bad', offsets: { from: null, to: null } },
      { text: ' also good', offsets: { from: 1000, to: 1500 } },
    ]

    const words = parseWhisperJsonWords(tokens)
    expect(words).toEqual([
      { text: 'good', startMs: 0, endMs: 500 },
      { text: 'also', startMs: 1000, endMs: 1500, leadingSpace: true },
      { text: 'good', startMs: 1000, endMs: 1500, leadingSpace: true },
    ])
  })

  it('skips tokens where end <= start', () => {
    const tokens = [
      { text: 'valid', offsets: { from: 0, to: 500 } },
      { text: ' zero-length', offsets: { from: 600, to: 600 } },
      { text: ' reversed', offsets: { from: 1000, to: 500 } },
    ]

    const words = parseWhisperJsonWords(tokens)
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('valid')
  })

  it('returns empty array for non-array input', () => {
    expect(parseWhisperJsonWords(null)).toEqual([])
    expect(parseWhisperJsonWords(undefined)).toEqual([])
    expect(parseWhisperJsonWords('string')).toEqual([])
  })

  it('skips null and non-object tokens', () => {
    const tokens = [null, 42, 'string', { text: 'valid', offsets: { from: 0, to: 500 } }]
    const words = parseWhisperJsonWords(tokens)
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('valid')
  })

  it('concatenates parts without spaces into a single word', () => {
    const tokens = [
      { text: 'He', offsets: { from: 0, to: 300 } },
      { text: 'llo', offsets: { from: 300, to: 500 } },
    ]

    const words = parseWhisperJsonWords(tokens)
    expect(words).toEqual([
      { text: 'Hello', startMs: 0, endMs: 500 },
    ])
  })
})

describe('parseWhisperJsonCues', () => {
  it('parses valid whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: 'Hello world',
          offsets: { from: 0, to: 3000 },
          tokens: [
            { text: 'Hello', offsets: { from: 0, to: 1500 } },
            { text: ' world', offsets: { from: 1500, to: 3000 } },
          ],
        },
      ],
    })

    const cues = parseWhisperJsonCues(json)
    expect(cues).toHaveLength(1)
    expect(cues[0].id).toBe('caption-1')
    expect(cues[0].startMs).toBe(0)
    expect(cues[0].endMs).toBe(3000)
    expect(cues[0].text).toBe('Hello world')
    expect(cues[0].words).toHaveLength(2)
  })

  it('falls back to segment text when tokens have bad timing', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: 'Fallback text',
          offsets: { from: 0, to: 2000 },
          tokens: [
            { text: 'bad', offsets: { from: null, to: null } },
          ],
        },
      ],
    })

    const cues = parseWhisperJsonCues(json)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('Fallback text')
    expect(cues[0].words).toBeUndefined()
  })

  it('returns empty array for invalid JSON', () => {
    expect(parseWhisperJsonCues('not json')).toEqual([])
  })

  it('returns empty array when transcription is not an array', () => {
    expect(parseWhisperJsonCues(JSON.stringify({ transcription: 'nope' }))).toEqual([])
    expect(parseWhisperJsonCues(JSON.stringify({}))).toEqual([])
  })

  it('filters out segments with invalid timing', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'valid', offsets: { from: 0, to: 1000 } },
        { text: 'bad timing', offsets: { from: 2000, to: 1000 } },
      ],
    })

    const cues = parseWhisperJsonCues(json)
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toBe('valid')
  })

  it('handles mix of valid tokens and tokens with bad timing in same segment', () => {
    const json = JSON.stringify({
      transcription: [
        {
          text: 'segment text',
          offsets: { from: 0, to: 5000 },
          tokens: [
            { text: 'good', offsets: { from: 0, to: 1000 } },
            { text: ' bad', offsets: { from: null, to: null } },
            { text: ' fine', offsets: { from: 2000, to: 3000 } },
          ],
        },
      ],
    })

    const cues = parseWhisperJsonCues(json)
    expect(cues).toHaveLength(1)
    expect(cues[0].words).toHaveLength(2)
    expect(cues[0].words![0].text).toBe('good')
    expect(cues[0].words![1].text).toBe('fine')
  })
})

describe('buildCaptionTextFromWords', () => {
  it('joins words respecting leadingSpace', () => {
    const words = [
      { text: 'Hello', startMs: 0, endMs: 500 },
      { text: 'world', startMs: 500, endMs: 1000, leadingSpace: true },
    ]
    expect(buildCaptionTextFromWords(words)).toBe('Hello world')
  })

  it('joins words without spaces when leadingSpace is absent', () => {
    const words = [
      { text: 'He', startMs: 0, endMs: 300 },
      { text: 'llo', startMs: 300, endMs: 500 },
    ]
    expect(buildCaptionTextFromWords(words)).toBe('Hello')
  })
})

describe('shouldRetryWhisperWithoutJson', () => {
  it('returns true for unknown argument errors', () => {
    expect(shouldRetryWhisperWithoutJson(new Error('unknown argument: -ojf'))).toBe(true)
    expect(shouldRetryWhisperWithoutJson(new Error('output-json-full not supported'))).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(shouldRetryWhisperWithoutJson(new Error('file not found'))).toBe(false)
    expect(shouldRetryWhisperWithoutJson(new Error('segmentation fault'))).toBe(false)
  })

  it('handles non-Error values', () => {
    expect(shouldRetryWhisperWithoutJson('unknown argument')).toBe(true)
    expect(shouldRetryWhisperWithoutJson('some other error')).toBe(false)
  })
})
