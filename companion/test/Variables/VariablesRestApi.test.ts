import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import { VariablesController } from '../../lib/Variables/Controller.js'
import { createVariablesRestApiRouter, VARIABLES_API_BASE_PATH } from '../../lib/Variables/VariablesRestApi.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'
import { FakeDataDatabase } from '../utils/FakeTableView.js'
import { mockUserConfig } from '../utils/MockUserConfig.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = {
	read: mint(['read']),
	write: mint(['read', 'write']),
	execute: mint(['execute']),
}

const VARIABLES_PATH = `${REST_API_BASE_PATH}${VARIABLES_API_BASE_PATH}`

/** A real VariablesController on an in-memory database */
function createFixture() {
	const controller = new VariablesController(new FakeDataDatabase().asDataDatabase(), mockUserConfig({ timezone: '' }))

	controller.definitions.setVariableDefinitions('kumo', [
		{ name: 'dest_1_source', description: 'Source routed to destination 1' },
		{ name: 'connected', description: 'Connection state' },
	])
	controller.values.setVariableValues('kumo', [
		{ id: 'dest_1_source', value: 4 },
		{ id: 'connected', value: true },
	])

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			variables: { createRestApiRouter: (logger) => createVariablesRestApiRouter(logger, controller) },
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)

	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)

	const request = (
		method: 'get' | 'post' | 'put' | 'patch' | 'delete',
		path: string,
		body?: object,
		token = tokens.write
	) => {
		const req = supertest(app)[method](`${VARIABLES_PATH}${path}`).set('Authorization', `Bearer ${token}`)
		return body ? req.send(body) : req
	}

	return { controller, request }
}

describe('Variables REST API', () => {
	describe('custom variables', () => {
		test('creates a variable with every field', async () => {
			const { request, controller } = createFixture()
			const res = await request('post', '/custom', {
				name: 'chord_dit_fired',
				defaultValue: false,
				description: 'Chord fired',
			})

			expect(res.status).toBe(201)
			expect(res.headers.location).toBe(`${VARIABLES_PATH}/custom/chord_dit_fired`)
			expect(res.body.data).toEqual({
				name: 'chord_dit_fired',
				description: 'Chord fired',
				defaultValue: false,
				currentValue: false,
				persistCurrentValue: false,
				collectionId: null,
			})
			expect(controller.custom.getValue('chord_dit_fired')).toBe(false)
		})

		test('defaults to an empty string value', async () => {
			const { request } = createFixture()
			const res = await request('post', '/custom', { name: 'menu_page_dit' })

			expect(res.body.data).toMatchObject({ defaultValue: '', currentValue: '' })
		})

		test('rejects duplicate and invalid names', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'a' })

			expect((await request('post', '/custom', { name: 'a' })).status).toBe(409)
			expect((await request('post', '/custom', { name: 'has space' })).status).toBe(400)
			expect((await request('post', '/custom', { name: 'constructor' })).status).toBe(400)
		})

		test('lists and gets variables', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'b_var', defaultValue: 2 })
			await request('post', '/custom', { name: 'a_var', defaultValue: 1 })

			const list = await request('get', '/custom', undefined, tokens.read)
			expect(list.body.data.map((v: any) => v.name)).toEqual(['a_var', 'b_var'])
			expect(list.body.meta).toEqual({ total: 2, limit: 2, offset: 0 })

			const one = await request('get', '/custom/b_var', undefined, tokens.read)
			expect(one.body.data).toMatchObject({ name: 'b_var', defaultValue: 2, currentValue: 2 })
		})

		test('returns 404 for unknown and prototype names', async () => {
			const { request } = createFixture()

			expect((await request('get', '/custom/nope')).status).toBe(404)
			expect((await request('get', '/custom/toString')).status).toBe(404)
			expect((await request('delete', '/custom/nope')).status).toBe(404)
			expect((await request('put', '/custom/nope/value', { value: 1 }, tokens.execute)).status).toBe(404)
		})

		test('updates description and default value without touching the current value', async () => {
			const { request, controller } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'a' })
			controller.custom.setValue('v', 'live')

			const res = await request('patch', '/custom/v', { description: 'New', defaultValue: 'b' })

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject({ description: 'New', defaultValue: 'b', currentValue: 'live' })
		})

		test('stores null as a value', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'a' })

			const res = await request('patch', '/custom/v', { defaultValue: null })
			expect(res.body.data.defaultValue).toBeNull()
		})

		test('turning on persistence copies the current value into the default', async () => {
			const { request, controller } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'a' })
			controller.custom.setValue('v', 'live')

			const res = await request('patch', '/custom/v', { persistCurrentValue: true })
			expect(res.body.data).toMatchObject({ persistCurrentValue: true, defaultValue: 'live' })
		})

		test('rejects a default value while persisting, without changing anything', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'a', persistCurrentValue: true })

			const res = await request('patch', '/custom/v', { defaultValue: 'b', description: 'changed' })
			expect(res.status).toBe(409)

			const after = await request('get', '/custom/v')
			expect(after.body.data).toMatchObject({ defaultValue: 'a', description: 'A custom variable' })
		})

		test('can turn persistence off and set the default in one request', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'a', persistCurrentValue: true })

			const res = await request('patch', '/custom/v', { persistCurrentValue: false, defaultValue: 'b' })

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject({ persistCurrentValue: false, defaultValue: 'b' })
		})

		test('deletes a variable', async () => {
			const { request, controller } = createFixture()
			await request('post', '/custom', { name: 'v' })

			expect((await request('delete', '/custom/v')).status).toBe(204)
			expect(controller.custom.hasCustomVariable('v')).toBe(false)
		})

		test('reads and sets the current value', async () => {
			const { request, controller } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 0 })

			const set = await request('put', '/custom/v/value', { value: { a: [1, 2] } }, tokens.execute)
			expect(set.status).toBe(200)
			expect(set.body.data).toEqual({ name: 'v', value: { a: [1, 2] } })
			expect(controller.custom.getValue('v')).toEqual({ a: [1, 2] })

			const get = await request('get', '/custom/v/value', undefined, tokens.read)
			expect(get.body.data).toEqual({ name: 'v', value: { a: [1, 2] } })
		})

		test('setting a value needs the execute scope', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'v' })

			expect((await request('put', '/custom/v/value', { value: 1 }, tokens.write)).status).toBe(403)
		})

		test('read tokens cannot write', async () => {
			const { request } = createFixture()
			expect((await request('post', '/custom', { name: 'v' }, tokens.read)).status).toBe(403)
		})
	})

	describe('values', () => {
		test('lists connection and custom variables with values, ordered by namespace and name', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'menu_page_dit', defaultValue: 2, description: 'DIT menu page' })

			const res = await request('get', '/values', undefined, tokens.read)

			expect(res.status).toBe(200)
			expect(res.body.data).toEqual([
				{ namespace: 'custom', name: 'menu_page_dit', description: 'DIT menu page', value: 2 },
				{ namespace: 'kumo', name: 'connected', description: 'Connection state', value: true },
				{ namespace: 'kumo', name: 'dest_1_source', description: 'Source routed to destination 1', value: 4 },
			])
		})

		test('filters by namespace and search, and paginates', async () => {
			const { request } = createFixture()

			const byNamespace = await request('get', '/values?namespace=kumo&q=DEST')
			expect(byNamespace.body.data.map((v: any) => v.name)).toEqual(['dest_1_source'])

			const paged = await request('get', '/values?limit=1&offset=1')
			expect(paged.body.meta).toEqual({ total: 2, limit: 1, offset: 1 })
			expect(paged.body.data.map((v: any) => v.name)).toEqual(['dest_1_source'])
		})

		test('omits the value when a variable has none', async () => {
			const { request, controller } = createFixture()
			controller.definitions.setVariableDefinitions('kumo', [{ name: 'unset', description: 'No value yet' }])

			const res = await request('get', '/values/kumo/unset')
			expect(res.body.data).toEqual({ namespace: 'kumo', name: 'unset', description: 'No value yet' })
		})

		test('gets a single variable', async () => {
			const { request } = createFixture()
			await request('post', '/custom', { name: 'v', defaultValue: 'x' })

			expect((await request('get', '/values/kumo/dest_1_source')).body.data.value).toBe(4)
			expect((await request('get', '/values/custom/v')).body.data.value).toBe('x')
			expect((await request('get', '/values/kumo/nope')).status).toBe(404)
			expect((await request('get', '/values/nope/x')).status).toBe(404)
		})
	})
})
