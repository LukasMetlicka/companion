import { describe, expect, test } from 'vitest'
import { checkIfMatch, computeEtag } from '../../../lib/Service/RestApi/etag.js'

describe('computeEtag', () => {
	test('ignores key order at every level', () => {
		expect(computeEtag({ a: 1, b: { c: [1, { d: 2, e: 3 }] } })).toBe(
			computeEtag({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 })
		)
	})

	test('ignores undefined properties, like JSON', () => {
		expect(computeEtag({ a: 1, b: undefined })).toBe(computeEtag({ a: 1 }))
	})

	test('changes when content changes', () => {
		expect(computeEtag({ a: 1 })).not.toBe(computeEtag({ a: 2 }))
		expect(computeEtag([1, 2])).not.toBe(computeEtag([2, 1]))
	})

	test('is a quoted strong tag', () => {
		expect(computeEtag({})).toMatch(/^"[\w-]+"$/)
	})
})

describe('checkIfMatch', () => {
	const current = computeEtag({ a: 1 })

	test('allows requests without If-Match', () => {
		expect(() => checkIfMatch({}, current)).not.toThrow()
		expect(() => checkIfMatch({}, null)).not.toThrow()
	})

	test('allows a matching tag, including in a list or as a weak tag', () => {
		expect(() => checkIfMatch({ 'if-match': current }, current)).not.toThrow()
		expect(() => checkIfMatch({ 'if-match': `"other", ${current}` }, current)).not.toThrow()
		expect(() => checkIfMatch({ 'if-match': `W/${current}` }, current)).not.toThrow()
	})

	test('rejects a stale tag with 412 and the current tag', () => {
		expect(() => checkIfMatch({ 'if-match': '"stale"' }, current)).toThrow(
			expect.objectContaining({ statusCode: 412, code: 'PRECONDITION_FAILED', details: { currentEtag: current } })
		)
	})

	test('* requires the resource to exist', () => {
		expect(() => checkIfMatch({ 'if-match': '*' }, current)).not.toThrow()
		expect(() => checkIfMatch({ 'if-match': '*' }, null)).toThrow(expect.objectContaining({ statusCode: 412 }))
	})

	test('any tag fails when the resource does not exist', () => {
		expect(() => checkIfMatch({ 'if-match': current }, null)).toThrow(expect.objectContaining({ statusCode: 412 }))
	})
})
