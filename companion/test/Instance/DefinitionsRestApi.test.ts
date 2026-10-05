import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType, FeedbackEntitySubType } from '../../../shared-lib/lib/Model/EntityModel.js'
import {
	createDefinitionsRestApiRouter,
	DEFINITIONS_API_BASE_PATH,
	type DefinitionsSource,
} from '../../lib/Instance/DefinitionsRestApi.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = {
	read: mint(['read']),
	connections: mint(['connections']),
}

const DEFINITIONS_PATH = `${REST_API_BASE_PATH}${DEFINITIONS_API_BASE_PATH}`

function createDefinition(label: string, props: Partial<ClientEntityDefinition> = {}): ClientEntityDefinition {
	return {
		entityType: EntityModelType.Action,
		label,
		sortKey: null,
		description: undefined,
		options: [],
		optionsToMonitorForInvalidations: null,
		feedbackType: null,
		feedbackStyle: undefined,
		hasLifecycleFunctions: false,
		hasLearn: false,
		learnTimeout: undefined,
		showInvert: false,
		actionHasResult: undefined,
		feedbackAffectedProperties: undefined,
		optionsSupportExpressions: true,
		...props,
	} as ClientEntityDefinition
}

const routeAction = createDefinition('Route input to output', {
	description: 'Switch a crosspoint',
	options: [
		{
			id: 'input',
			type: 'dropdown',
			label: 'Input',
			default: 1,
			choices: [
				{ id: 1, label: 'Camera 1' },
				{ id: 2, label: 'Camera 2' },
			],
		},
	],
})

const actions: Record<string, Record<string, ClientEntityDefinition>> = {
	kumo: {
		route: routeAction,
		salvo: createDefinition('Fire salvo', { actionHasResult: true }),
	},
	internal: {
		set_page: createDefinition('Surface: Set page'),
	},
}

const feedbacks: Record<string, Record<string, ClientEntityDefinition>> = {
	kumo: {
		routed: createDefinition('Input is routed', {
			entityType: EntityModelType.Feedback,
			feedbackType: FeedbackEntitySubType.Boolean,
			showInvert: true,
		}),
	},
}

const definitions: DefinitionsSource = {
	getAllEntityDefinitions: (entityType) => (entityType === EntityModelType.Action ? actions : feedbacks),
	getEntityDefinition: (entityType, connectionId, definitionId) =>
		(entityType === EntityModelType.Action ? actions : feedbacks)[connectionId]?.[definitionId],
}

function createApp(): express.Express {
	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			instance: { createRestApiRouter: (logger) => createDefinitionsRestApiRouter(logger, definitions) },
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)

	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)
	return app
}

const app = createApp()
const get = (path: string, token = tokens.read) =>
	supertest(app).get(`${DEFINITIONS_PATH}${path}`).set('Authorization', `Bearer ${token}`)
const post = (path: string, body: unknown, token = tokens.read) =>
	supertest(app)
		.post(`${DEFINITIONS_PATH}${path}`)
		.set('Authorization', `Bearer ${token}`)
		.send(body as object)

describe('Definitions REST API', () => {
	describe('auth', () => {
		test('rejects requests without a token', async () => {
			const res = await supertest(app).get(`${DEFINITIONS_PATH}/actions`)
			expect(res.status).toBe(401)
		})

		test('rejects tokens without read scope', async () => {
			const res = await get('/actions', tokens.connections)
			expect(res.status).toBe(403)
		})
	})

	describe('GET /actions', () => {
		test('lists all actions ordered by connection, then label', async () => {
			const res = await get('/actions')

			expect(res.status).toBe(200)
			expect(res.body.meta).toEqual({ total: 3, limit: 100, offset: 0 })
			expect(res.body.data.map((d: any) => `${d.connectionId}/${d.definitionId}`)).toEqual([
				'internal/set_page',
				'kumo/salvo',
				'kumo/route',
			])
		})

		test('returns the full definition shape', async () => {
			const res = await get('/actions?connectionId=kumo&q=route')

			expect(res.body.data).toEqual([
				{
					connectionId: 'kumo',
					definitionId: 'route',
					label: 'Route input to output',
					description: 'Switch a crosspoint',
					sortKey: null,
					optionsSupportExpressions: true,
					hasLearn: false,
					hasResult: false,
					options: routeAction.options,
				},
			])
		})

		test('filters by connection', async () => {
			const res = await get('/actions?connectionId=internal')
			expect(res.body.data.map((d: any) => d.definitionId)).toEqual(['set_page'])
		})

		test('searches id, label and description case-insensitively', async () => {
			expect((await get('/actions?q=SALVO')).body.data.map((d: any) => d.definitionId)).toEqual(['salvo'])
			expect((await get('/actions?q=crosspoint')).body.data.map((d: any) => d.definitionId)).toEqual(['route'])
			expect((await get('/actions?q=set_page')).body.data.map((d: any) => d.definitionId)).toEqual(['set_page'])
		})

		test('paginates', async () => {
			const res = await get('/actions?limit=1&offset=1')

			expect(res.body.meta).toEqual({ total: 3, limit: 1, offset: 1 })
			expect(res.body.data.map((d: any) => d.definitionId)).toEqual(['salvo'])
		})

		test('rejects an out of range limit', async () => {
			const res = await get('/actions?limit=5000')
			expect(res.status).toBe(400)
		})
	})

	describe('GET /feedbacks', () => {
		test('includes feedback specific fields', async () => {
			const res = await get('/feedbacks')

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject([
				{ connectionId: 'kumo', definitionId: 'routed', feedbackType: 'boolean', showInvert: true },
			])
			expect(res.body.data[0]).not.toHaveProperty('hasResult')
		})
	})

	describe('GET /:type/:connectionId/:definitionId', () => {
		test('returns one definition', async () => {
			const res = await get('/actions/kumo/salvo')

			expect(res.status).toBe(200)
			expect(res.body.data).toMatchObject({ connectionId: 'kumo', definitionId: 'salvo', hasResult: true })
		})

		test('returns 404 for an unknown definition or connection', async () => {
			expect((await get('/actions/kumo/nope')).status).toBe(404)
			expect((await get('/actions/nope/route')).status).toBe(404)
			expect((await get('/feedbacks/kumo/route')).status).toBe(404)
		})
	})

	describe('POST /:type/:connectionId/:definitionId/validate', () => {
		test('reports valid options', async () => {
			const res = await post('/actions/kumo/route/validate', { options: { input: { isExpression: false, value: 2 } } })

			expect(res.status).toBe(200)
			expect(res.body.data).toEqual({ valid: true, errors: [], warnings: [] })
		})

		test('reports invalid options with structured errors', async () => {
			const res = await post('/actions/kumo/route/validate', {
				options: { input: { isExpression: false, value: 7 }, nope: { isExpression: false, value: 1 } },
			})

			expect(res.status).toBe(200)
			expect(res.body.data.valid).toBe(false)
			expect(res.body.data.errors).toMatchObject([
				{ optionId: 'nope', code: 'unknown_option' },
				{ optionId: 'input', code: 'invalid_value' },
			])
		})

		test('returns 404 for an unknown definition', async () => {
			const res = await post('/actions/kumo/nope/validate', { options: {} })
			expect(res.status).toBe(404)
		})

		test('rejects a malformed body', async () => {
			expect((await post('/actions/kumo/route/validate', {})).status).toBe(400)
			expect((await post('/actions/kumo/route/validate', { options: {}, extra: 1 })).status).toBe(400)
		})
	})
})
