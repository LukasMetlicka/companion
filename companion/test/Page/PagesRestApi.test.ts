import { EventEmitter } from 'node:events'
import express from 'express'
import supertest from 'supertest'
import { describe, expect, test, vi } from 'vitest'
import type { PageModel } from '@companion-app/shared/Model/PageModel.js'
import type { ControlCommonEvents } from '../../lib/Controls/ControlDependencies.js'
import { PageController } from '../../lib/Page/Controller.js'
import { createPagesRestApiRouter, PAGES_API_BASE_PATH } from '../../lib/Page/PagesRestApi.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'
import { createStore, threePages } from './Helpers.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = {
	read: mint(['read']),
	write: mint(['read', 'write']),
}

const PAGES_PATH = `${REST_API_BASE_PATH}${PAGES_API_BASE_PATH}`

/** A real PageController and store, with the controls and graphics it drives faked */
function createFixture(initialPages: PageModel[] = threePages()) {
	const { store } = createStore(initialPages)

	const graphics = { clearAllForPage: vi.fn(), invalidateButton: vi.fn() }
	const controls = {
		deleteControl: vi.fn(),
		createButtonControl: vi.fn(),
		createPageControl: vi.fn(),
		clearPageVariables: vi.fn(),
		getControl: vi.fn((controlId: string) => ({
			controlId,
			type: 'button-layered',
			triggerLocationHasChanged: vi.fn(),
		})),
	}
	const userconfig = { getKey: vi.fn(() => ({ minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 })) }
	const controller = new PageController(
		graphics as any,
		controls as any,
		userconfig as any,
		new EventEmitter<ControlCommonEvents>(),
		store
	)

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			page: { createRestApiRouter: (logger) => createPagesRestApiRouter(logger, controller, controls as any) },
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)

	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)

	const request = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object, token = tokens.write) => {
		const req = supertest(app)[method](`${PAGES_PATH}${path}`).set('Authorization', `Bearer ${token}`)
		return body ? req.send(body) : req
	}

	return { store, controls, controller, request }
}

const pageOrder = (store: ReturnType<typeof createFixture>['store']) => [...store.getPageIds()]

describe('Pages REST API', () => {
	describe('auth', () => {
		test('read tokens cannot write', async () => {
			const { request } = createFixture()

			expect((await request('get', '/', undefined, tokens.read)).status).toBe(200)
			expect((await request('post', '/', {}, tokens.read)).status).toBe(403)
		})
	})

	describe('GET /', () => {
		test('lists pages in order with ids, numbers and control counts', async () => {
			const { request } = createFixture()
			const res = await request('get', '/')

			expect(res.status).toBe(200)
			expect(res.body).toEqual({
				data: [
					{ id: 'page-a', number: 1, name: 'First', controlCount: 1 },
					{ id: 'page-b', number: 2, name: 'Second', controlCount: 2 },
					{ id: 'page-c', number: 3, name: 'Third', controlCount: 1 },
				],
				meta: { total: 3, limit: 3, offset: 0 },
			})
		})
	})

	describe('GET /:pageId', () => {
		test('returns the page grid ordered by row then column', async () => {
			const { request } = createFixture()
			const res = await request('get', '/page-b')

			expect(res.status).toBe(200)
			expect(res.body.data).toEqual({
				id: 'page-b',
				number: 2,
				name: 'Second',
				controls: [
					{ row: 1, column: 2, controlId: 'control-b1', type: 'button-layered' },
					{ row: 1, column: 3, controlId: 'control-b2', type: 'button-layered' },
				],
			})
		})

		test('returns 404 for an unknown page', async () => {
			const { request } = createFixture()
			expect((await request('get', '/nope')).status).toBe(404)
		})
	})

	describe('POST /', () => {
		test('appends a page with default nav buttons by default', async () => {
			const { request, store, controls } = createFixture()
			const res = await request('post', '/', { name: 'DIT' })

			expect(res.status).toBe(201)
			expect(res.body.data).toMatchObject({ number: 4, name: 'DIT' })
			expect(res.headers.location).toBe(`${PAGES_PATH}/${res.body.data.id}`)
			expect(pageOrder(store)[3]).toBe(res.body.data.id)
			expect(controls.createButtonControl).toHaveBeenCalledTimes(3)
		})

		test('inserts at a position without nav buttons, shifting later pages', async () => {
			const { request, store, controls } = createFixture()
			const res = await request('post', '/', { name: 'DIT', number: 1, defaultNavButtons: false })

			expect(res.status).toBe(201)
			expect(res.body.data.number).toBe(1)
			expect(pageOrder(store)).toEqual([res.body.data.id, 'page-a', 'page-b', 'page-c'])
			expect(controls.createButtonControl).not.toHaveBeenCalled()
			expect(controls.createPageControl).toHaveBeenCalledWith(res.body.data.id)
		})

		test('defaults the name', async () => {
			const { request } = createFixture()
			expect((await request('post', '/', {})).body.data.name).toBe('PAGE')
		})

		test('rejects a position past the end', async () => {
			const { request } = createFixture()
			expect((await request('post', '/', { number: 5 })).status).toBe(400)
			expect((await request('post', '/', { number: 0 })).status).toBe(400)
		})

		test('rejects unknown body fields', async () => {
			const { request } = createFixture()
			expect((await request('post', '/', { title: 'x' })).status).toBe(400)
		})
	})

	describe('PATCH /:pageId', () => {
		test('renames a page', async () => {
			const { request, store } = createFixture()
			const res = await request('patch', '/page-b', { name: 'Renamed' })

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject({ id: 'page-b', number: 2, name: 'Renamed' })
			expect(store.getPageName(2)).toBe('Renamed')
		})

		test('moves a page, keeping every id', async () => {
			const { request, store } = createFixture()
			const res = await request('patch', '/page-c', { number: 1 })

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject({ id: 'page-c', number: 1 })
			expect(pageOrder(store)).toEqual(['page-c', 'page-a', 'page-b'])
		})

		test('renames and moves in one request', async () => {
			const { request } = createFixture()
			const res = await request('patch', '/page-a', { name: 'Last', number: 3 })

			expect(res.body.data).toMatchObject({ id: 'page-a', number: 3, name: 'Last' })
		})

		test('moving to the current position is a no-op', async () => {
			const { request, store } = createFixture()
			const res = await request('patch', '/page-b', { number: 2 })

			expect(res.status).toBe(200)
			expect(pageOrder(store)).toEqual(['page-a', 'page-b', 'page-c'])
		})

		test('rejects an out of range position without renaming', async () => {
			const { request, store } = createFixture()
			const res = await request('patch', '/page-b', { name: 'Renamed', number: 4 })

			expect(res.status).toBe(400)
			expect(store.getPageName(2)).toBe('Second')
		})

		test('returns 404 for an unknown page', async () => {
			const { request } = createFixture()
			expect((await request('patch', '/nope', { name: 'x' })).status).toBe(404)
		})
	})

	describe('DELETE /:pageId', () => {
		test('deletes the page and its controls', async () => {
			const { request, store, controls } = createFixture()
			const res = await request('delete', '/page-b')

			expect(res.status).toBe(204)
			expect(pageOrder(store)).toEqual(['page-a', 'page-c'])
			expect(controls.deleteControl).toHaveBeenCalledWith('control-b1')
			expect(controls.deleteControl).toHaveBeenCalledWith('control-b2')
		})

		test('refuses to delete the last page', async () => {
			const { request, store } = createFixture([threePages()[0]])
			const res = await request('delete', '/page-a')

			expect(res.status).toBe(409)
			expect(pageOrder(store)).toEqual(['page-a'])
		})

		test('returns 404 for an unknown page', async () => {
			const { request } = createFixture()
			expect((await request('delete', '/nope')).status).toBe(404)
		})
	})

	describe('POST /:pageId/clear', () => {
		test('deletes controls and resets the page, keeping id and position', async () => {
			const { request, controls } = createFixture()
			const res = await request('post', '/page-b/clear', { defaultNavButtons: false })

			expect(res.status).toBe(200)
			expect(res.body.data).toEqual({ id: 'page-b', number: 2, name: 'PAGE', controls: [] })
			expect(controls.deleteControl).toHaveBeenCalledWith('control-b1')
			expect(controls.clearPageVariables).toHaveBeenCalledWith('page-b')
			expect(controls.createButtonControl).not.toHaveBeenCalled()
		})

		test('re-adds the default nav buttons by default', async () => {
			const { request, controls } = createFixture()
			await request('post', '/page-b/clear', {})

			expect(controls.createButtonControl).toHaveBeenCalledTimes(3)
		})
	})
})
