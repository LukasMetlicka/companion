import { createHash } from 'node:crypto'
import type Express from 'express'
import { RestApiError } from './errors.js'

/**
 * Compute an ETag for a resource representation.
 *
 * The tag is a hash of a canonical serialization (object keys sorted at every level), so it only changes
 * when the content does, regardless of key order. Callers strip anything that is not meaningful content
 * (e.g. regenerated internal ids) before passing the value in.
 */
export function computeEtag(value: unknown): string {
	return `"${createHash('sha256').update(canonicalStringify(value)).digest('base64url')}"`
}

/**
 * Enforce an If-Match request header against the current ETag of a resource.
 *
 * - No header: always allowed.
 * - `*`: allowed only if the resource exists.
 * - A list of tags: allowed only if one of them equals the current tag.
 *
 * Throws 412 PRECONDITION_FAILED otherwise, so a client never overwrites a change it has not seen.
 *
 * @param currentEtag The ETag of the resource as it is now, or null if it does not exist
 */
export function checkIfMatch(headers: Express.Request['headers'], currentEtag: string | null): void {
	const ifMatch = headers['if-match']
	if (ifMatch === undefined) return

	const tags = ifMatch.split(',').map((tag) => tag.trim())
	if (tags.includes('*')) {
		if (currentEtag !== null) return
	} else if (currentEtag !== null && tags.some((tag) => stripWeak(tag) === stripWeak(currentEtag))) {
		return
	}

	throw new RestApiError(
		412,
		'PRECONDITION_FAILED',
		currentEtag === null
			? 'The resource does not exist'
			: 'The resource has changed since it was read (If-Match does not match the current ETag)',
		{ currentEtag }
	)
}

function stripWeak(tag: string): string {
	return tag.startsWith('W/') ? tag.slice(2) : tag
}

function canonicalStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`)
		return `{${entries.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}
