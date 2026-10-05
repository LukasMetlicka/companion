import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import type { SurfaceGroupConfig } from '../../../shared-lib/lib/Model/Surfaces.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import {
	createSurfaceGroupsRestApiRouter,
	SURFACE_GROUPS_API_BASE_PATH,
	type SurfaceGroupsApiDeps,
} from '../../lib/Surface/SurfaceGroupsRestApi.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = { read: mint(['read']), write: mint(['read', 'write']) }

const PATH = `${REST_API_BASE_PATH}${SURFACE_GROUPS_API_BASE_PATH}`
const PAGES = ['home', 'dit-1', 'dit-2']

/** Online deck 'deck:1' (auto group) and offline deck 'deck:2', with the page rules Companion applies */
function createFixture() {
	const configs: Record<string, SurfaceGroupConfig> = {
		'deck:1': { name: '', last_page_id: 'home', startup_page_id: 'home', use_last_page: true, never_lock: false },
		'deck:2': { name: '', last_page_id: 'home', startup_page_id: 'home', use_last_page: true, never_lock: false },
	}
	const currentPage: Record<string, string> = { 'deck:1': 'home' }

	const deps: SurfaceGroupsApiDeps = {
		surfaces: {
			getDevicesList: () =>
				Object.keys(configs).map((id, index) => ({
					id,
					index,
					displayName: `Deck ${id}`,
					isAutoGroup: true,
					surfaces: [{ id } as any],
				})),
			getGroupConfig: (groupId: string) => configs[groupId] ?? null,
			setGroupConfigKey: (groupId: string, key: string, value: any) => {
				if (!configs[groupId]) throw new Error(`Group does not exist: ${groupId}`)
				;(configs[groupId] as any)[key] = value
				return undefined
			},
			devicePageSet: (groupId: string, pageId: string) => {
				const config = configs[groupId]
				// Companion refuses pages outside the allowed list
				if (config.restrict_pages && !config.allowed_page_ids?.includes(pageId)) return
				currentPage[groupId] = pageId
			},
			devicePageGet: (groupId: string) => currentPage[groupId],
		},
		pageStore: { isPageIdValid: (pageId: string) => PAGES.includes(pageId) },
	}

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			surfaces: { createRestApiRouter: (logger) => createSurfaceGroupsRestApiRouter(logger, deps) },
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)
	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)

	const request = (method: 'get' | 'patch', path: string, body?: object, token = tokens.write) => {
		const req = supertest(app)[method](`${PATH}${path}`).set('Authorization', `Bearer ${token}`)
		return body ? req.send(body) : req
	}

	return { configs, currentPage, request }
}

describe('Surface groups REST API', () => {
	test('lists groups with their page settings', async () => {
		const { request } = createFixture()
		const res = await request('get', '/', undefined, tokens.read)

		expect(res.body.data).toEqual([
			{
				id: 'deck:1',
				name: 'Deck deck:1',
				isAutoGroup: true,
				surfaceIds: ['deck:1'],
				currentPageId: 'home',
				startupPageId: 'home',
				useLastPage: true,
				restrictPages: false,
				allowedPageIds: [],
				neverLock: false,
			},
			expect.objectContaining({ id: 'deck:2', currentPageId: null }),
		])
	})

	test('assigns a role: restricted pages, startup page and current page', async () => {
		const { request, configs, currentPage } = createFixture()
		const res = await request('patch', '/deck:1', {
			restrictPages: true,
			allowedPageIds: ['dit-1', 'dit-2'],
			startupPageId: 'dit-1',
			useLastPage: false,
			currentPageId: 'dit-1',
		})

		expect(res.status).toBe(200)
		expect(res.body.data).toMatchObject({
			currentPageId: 'dit-1',
			startupPageId: 'dit-1',
			useLastPage: false,
			restrictPages: true,
			allowedPageIds: ['dit-1', 'dit-2'],
		})
		expect(configs['deck:1']).toMatchObject({ restrict_pages: true, startup_page_id: 'dit-1' })
		expect(currentPage['deck:1']).toBe('dit-1')
	})

	test('refuses a current page outside the allowed pages', async () => {
		const { request, currentPage } = createFixture()
		await request('patch', '/deck:1', { restrictPages: true, allowedPageIds: ['dit-1'] })

		expect((await request('patch', '/deck:1', { currentPageId: 'home' })).status).toBe(409)
		expect(currentPage['deck:1']).toBe('home')
	})

	test('rejects unknown pages without changing anything', async () => {
		const { request, configs } = createFixture()
		const res = await request('patch', '/deck:1', { restrictPages: true, allowedPageIds: ['dit-1', 'nope'] })

		expect(res.status).toBe(400)
		expect(configs['deck:1'].restrict_pages).toBeUndefined()
	})

	test('an offline group gets its last page set instead', async () => {
		const { request, configs } = createFixture()
		const res = await request('patch', '/deck:2', { currentPageId: 'dit-2' })

		expect(res.status).toBe(200)
		expect(configs['deck:2'].last_page_id).toBe('dit-2')
	})

	test('404s an unknown group, and needs write scope', async () => {
		const { request } = createFixture()

		expect((await request('get', '/nope')).status).toBe(404)
		expect((await request('patch', '/nope', { neverLock: true })).status).toBe(404)
		expect((await request('patch', '/deck:1', { neverLock: true }, tokens.read)).status).toBe(403)
	})
})
