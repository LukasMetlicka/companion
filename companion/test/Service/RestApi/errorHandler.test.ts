import express from 'express'
import supertest from 'supertest'
import { describe, expect, test, vi } from 'vitest'

const { errorLog, debugLog } = vi.hoisted(() => ({ errorLog: vi.fn(), debugLog: vi.fn() }))

vi.mock('../../../lib/Log/Controller.js', () => ({
	default: { createLogger: () => ({ error: errorLog, debug: debugLog }) },
}))

const { restApiErrorHandler } = await import('../../../lib/Service/RestApi/middleware/errorHandler.js')
const { RestApiError } = await import('../../../lib/Service/RestApi/errors.js')

function createApp(error: Error) {
	const app = express()
	app.get('/thing', () => {
		throw error
	})
	app.use(restApiErrorHandler)
	return app
}

describe('restApiErrorHandler', () => {
	test('logs unexpected errors with their stack, and hides them from the response', async () => {
		errorLog.mockClear()
		const res = await supertest(createApp(new TypeError('boom')))
			.get('/thing?x=1')
			.set('Authorization', 'Bearer secret')

		expect(res.status).toBe(500)
		expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })

		expect(errorLog).toHaveBeenCalledTimes(1)
		const message = errorLog.mock.calls[0][0] as string
		expect(message).toContain('GET /thing?x=1')
		expect(message).toContain('boom')
		expect(message).toContain('errorHandler.test.ts') // the stack
		expect(message).not.toContain('secret')
	})

	test('logs API errors at debug level only', async () => {
		errorLog.mockClear()
		debugLog.mockClear()
		const res = await supertest(createApp(RestApiError.notFound('Page not found'))).get('/thing')

		expect(res.status).toBe(404)
		expect(errorLog).not.toHaveBeenCalled()
		expect(debugLog).toHaveBeenCalledWith('GET /thing -> 404 NOT_FOUND: Page not found')
	})
})
