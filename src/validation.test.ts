import { describe, it, expect } from 'vitest'
import { parseInput, validateInput, INVALID_INPUT } from './lib/validation'

function expectInvalidText(text: string) {
  expect(() => parseInput(text)).toThrow(INVALID_INPUT)
}

function expectInvalidData(data: unknown) {
  expect(() => validateInput(data)).toThrow(INVALID_INPUT)
}

describe('parseInput — malformed JSON', () => {
  it('rejects syntax errors', () => {
    expectInvalidText('{a: 1}')
    expectInvalidText('not json')
    expectInvalidText('{"a":')
    expectInvalidText('[{"a":1}]')
    expectInvalidText('')
    expectInvalidText('   ')
  })

  it('accepts valid minimal payload', () => {
    const parsed = parseInput('{"a":[0],"b":[0],"targets":[0]}')
    expect(parsed).toEqual({ a: [0], b: [0], targets: [0] })
  })
})

describe('validation — root shape', () => {
  it('requires exactly a, b, targets', () => {
    expectInvalidData({ a: [0], b: [0], targets: [0], extra: 1 })
    expectInvalidData({ a: [0], b: [0] })
    expectInvalidData({ a: [0], targets: [0] })
    expectInvalidData({ b: [0], targets: [0] })
    expectInvalidData({})
    expectInvalidData(null)
    expectInvalidData([])
    expectInvalidData(42)
    expectInvalidData('string')
    expectInvalidData(true)
  })
})

describe('validation — array types', () => {
  it('rejects non-array fields', () => {
    expectInvalidData({ a: 1, b: [0], targets: [0] })
    expectInvalidData({ a: [0], b: {}, targets: [0] })
    expectInvalidData({ a: [0], b: [0], targets: 'x' })
    expectInvalidData({ a: null, b: [0], targets: [0] })
  })

  it('rejects empty arrays', () => {
    expectInvalidData({ a: [], b: [0], targets: [0] })
    expectInvalidData({ a: [0], b: [], targets: [0] })
    expectInvalidData({ a: [0], b: [0], targets: [] })
  })
})

describe('validation — element types and bounds', () => {
  it('rejects non-integers', () => {
    expectInvalidData({ a: [1.5], b: [0], targets: [0] })
    expectInvalidData({ a: [NaN], b: [0], targets: [0] })
    expectInvalidData({ a: [Infinity], b: [0], targets: [0] })
    expectInvalidData({ a: ['1'], b: [0], targets: [0] })
    expectInvalidData({ a: [null], b: [0], targets: [0] })
    expectInvalidData({ a: [true], b: [0], targets: [0] })
    expectInvalidData({ a: [0], b: [0], targets: [1.2] })
  })

  it('rejects out-of-range shim values', () => {
    expectInvalidData({ a: [-1], b: [0], targets: [0] })
    expectInvalidData({ a: [200001], b: [0], targets: [0] })
    expectInvalidData({ a: [0], b: [-0.0001], targets: [0] })
  })

  it('rejects out-of-range targets', () => {
    expectInvalidData({ a: [0], b: [0], targets: [-1] })
    expectInvalidData({ a: [0], b: [0], targets: [400001] })
  })

  it('accepts exact boundaries', () => {
    expect(
      validateInput({ a: [0, 200000], b: [0, 200000], targets: [0, 400000] }),
    ).toEqual({
      a: [0, 200000],
      b: [0, 200000],
      targets: [0, 400000],
    })
  })
})

describe('validation — size limits', () => {
  it('rejects arrays longer than 100000', () => {
    const a = new Array(100001).fill(0)
    expectInvalidData({ a, b: [0], targets: [0] })
    const b = new Array(100001).fill(0)
    expectInvalidData({ a: [0], b, targets: [0] })
    const targets = new Array(100001).fill(0)
    expectInvalidData({ a: [0], b: [0], targets })
  })

  it('accepts arrays of exactly 100000', () => {
    const a = new Array(100000).fill(200000)
    const b = new Array(100000).fill(200000)
    const targets = new Array(100000).fill(400000)
    const parsed = validateInput({ a, b, targets })
    expect(parsed.a).toHaveLength(100000)
    expect(parsed.targets).toHaveLength(100000)
  })
})

describe('validation — duplicates allowed', () => {
  it('keeps duplicate targets in order', () => {
    const parsed = parseInput('{"a":[1,1,2],"b":[3,3],"targets":[4,4,5,4]}')
    expect(parsed.a).toEqual([1, 1, 2])
    expect(parsed.targets).toEqual([4, 4, 5, 4])
  })
})
