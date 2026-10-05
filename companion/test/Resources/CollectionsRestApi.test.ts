import express from 'express'
import supertest from 'supertest'
import { describe, expect, test, vi } from 'vitest'
import type { CollectionBase } from '../../../shared-lib/lib/Model/Collections.js'
import { createCollectionsResource } from '../../lib/Resources/CollectionsRestApi.js'
import { EnabledCollectionsBaseController } from '../../lib/Resources/EnabledCollectionsBase.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import { CustomVariableCollections } from '../../lib/Variables/CustomVariableCollections.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'
import { FakeDataDatabase, FakeTableView } from '../utils/FakeTableView.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = { read: mint(['read']), write: mint(['read', 'write']) }

/** A minimal enable-able collections controller, like the trigger collections */
class TestEnabledCollections extends EnabledCollectionsBaseController<{ enabled: boolean }> {
	readonly removeUnknownCollectionReferences = vi.fn()
	override emitUpdateUser(_rows: CollectionBase<{ enabled: boolean }>[]): void {}
}

const enabledResource = createCollectionsResource<{ enabled: boolean }>({
	basePath: '/things/v1/collections',
	tags: ['Things'],
	noun: 'thing',
	supportsEnabled: true,
	createMetaData: (enabled) => ({ enabled }),
})

const plainResource = createCollectionsResource<null>({
	basePath: '/plain/v1/collections',
	tags: ['Plain'],
	noun: 'plain thing',
	supportsEnabled: false,
	createMetaData: () => null,
})

function createFixture() {
	const enabled = new TestEnabledCollections(new FakeTableView<any>().asTableView())
	const plain = new CustomVariableCollections(new FakeDataDatabase().asDataDatabase(), () => {})

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			controls: {
				createRestApiRouter: (logger) => {
					const router = express.Router()
					router.use(enabledResource.createRouter(logger, enabled))
					router.use(plainResource.createRouter(logger, plain))
					return router
				},
			},
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)
	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)

	const request = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object, token = tokens.write) => {
		const req = supertest(app)[method](`${REST_API_BASE_PATH}${path}`).set('Authorization', `Bearer ${token}`)
		return body ? req.send(body) : req
	}

	const create = async (path: string, body: object) => (await request('post', path, body)).body.data.id as string

	return { enabled, plain, request, create }
}

const THINGS = '/things/v1/collections'
const PLAIN = '/plain/v1/collections'

describe('Collections REST API', () => {
	test('creates nested collections and lists them flat, depth first', async () => {
		const { request, create } = createFixture()
		const a = await create(THINGS, { name: 'A' })
		const child = await create(THINGS, { name: 'A child', parentId: a })
		const b = await create(THINGS, { name: 'B', position: 0 })

		const res = await request('get', THINGS, undefined, tokens.read)
		expect(res.body.data).toEqual([
			{ id: b, name: 'B', parentId: null, position: 0, enabled: true, effectiveEnabled: true },
			{ id: a, name: 'A', parentId: null, position: 1, enabled: true, effectiveEnabled: true },
			{ id: child, name: 'A child', parentId: a, position: 0, enabled: true, effectiveEnabled: true },
		])
	})

	test('a disabled parent disables its children effectively, but not directly', async () => {
		const { request, create } = createFixture()
		const a = await create(THINGS, { name: 'A' })
		const child = await create(THINGS, { name: 'A child', parentId: a })

		const res = await request('patch', `${THINGS}/${a}`, { enabled: false })
		expect(res.body.data).toMatchObject({ enabled: false, effectiveEnabled: false })

		const list = await request('get', THINGS)
		expect(list.body.data.find((c: any) => c.id === child)).toMatchObject({ enabled: true, effectiveEnabled: false })
	})

	test('creates disabled when asked', async () => {
		const { request } = createFixture()
		const res = await request('post', THINGS, { name: 'Off', enabled: false })
		expect(res.status).toBe(201)
		expect(res.headers.location).toBe(`${REST_API_BASE_PATH}${THINGS}/${res.body.data.id}`)
		expect(res.body.data.enabled).toBe(false)
	})

	test('renames and moves', async () => {
		const { request, create } = createFixture()
		const a = await create(THINGS, { name: 'A' })
		const b = await create(THINGS, { name: 'B' })

		const res = await request('patch', `${THINGS}/${b}`, { name: 'B2', parentId: a })
		expect(res.body.data).toMatchObject({ name: 'B2', parentId: a, position: 0 })

		const back = await request('patch', `${THINGS}/${b}`, { parentId: null, position: 0 })
		expect(back.body.data).toMatchObject({ parentId: null, position: 0 })
	})

	test('refuses to move a collection into itself or a descendant', async () => {
		const { request, create } = createFixture()
		const a = await create(THINGS, { name: 'A' })
		const child = await create(THINGS, { name: 'A child', parentId: a })

		expect((await request('patch', `${THINGS}/${a}`, { parentId: a })).status).toBe(400)
		expect((await request('patch', `${THINGS}/${a}`, { parentId: child })).status).toBe(400)
	})

	test('deleting re-homes child collections to the parent', async () => {
		const { request, create, enabled } = createFixture()
		const a = await create(THINGS, { name: 'A' })
		const child = await create(THINGS, { name: 'A child', parentId: a })

		expect((await request('delete', `${THINGS}/${a}`)).status).toBe(204)

		const list = await request('get', THINGS)
		expect(list.body.data).toMatchObject([{ id: child, parentId: null }])
		expect(enabled.removeUnknownCollectionReferences).toHaveBeenCalled()
	})

	test('404s and 400s', async () => {
		const { request } = createFixture()

		expect((await request('patch', `${THINGS}/nope`, { name: 'x' })).status).toBe(404)
		expect((await request('delete', `${THINGS}/nope`)).status).toBe(404)
		expect((await request('post', THINGS, { name: 'x', parentId: 'nope' })).status).toBe(400)
		expect((await request('post', THINGS, { name: '' })).status).toBe(400)
	})

	test('plain collections have no enabled state', async () => {
		const { request, create } = createFixture()
		const id = await create(PLAIN, { name: 'Chords' })

		const list = await request('get', PLAIN)
		expect(list.body.data).toEqual([{ id, name: 'Chords', parentId: null, position: 0 }])
		expect((await request('post', PLAIN, { name: 'x', enabled: false })).status).toBe(400)
		expect((await request('patch', `${PLAIN}/${id}`, { enabled: false })).status).toBe(400)
	})

	test('read tokens cannot write', async () => {
		const { request } = createFixture()
		expect((await request('post', THINGS, { name: 'x' }, tokens.read)).status).toBe(403)
	})
})
