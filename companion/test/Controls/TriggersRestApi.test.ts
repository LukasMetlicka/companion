import express from 'express'
import supertest from 'supertest'
import { describe, expect, test, vi } from 'vitest'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType } from '../../../shared-lib/lib/Model/EntityModel.js'
import type { TriggerModel } from '../../../shared-lib/lib/Model/TriggerModel.js'
import {
	createTriggersRestApiRouter,
	TRIGGERS_API_BASE_PATH,
	type TriggersApiDeps,
} from '../../lib/Controls/TriggersRestApi.js'
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
	write: mint(['read', 'write']),
	execute: mint(['execute']),
}

const TRIGGERS_PATH = `${REST_API_BASE_PATH}${TRIGGERS_API_BASE_PATH}`

function createDefinition(
	entityType: EntityModelType,
	props: Partial<ClientEntityDefinition> = {}
): ClientEntityDefinition {
	return {
		entityType,
		label: 'Test',
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
		actionHasResult: false,
		feedbackAffectedProperties: undefined,
		optionsSupportExpressions: true,
		showButtonPreview: false,
		supportsChildGroups: [],
		...props,
	}
}

const definitions: Record<string, ClientEntityDefinition> = {
	'action:internal:custom_log': createDefinition(EntityModelType.Action, {
		options: [{ id: 'message', type: 'textinput', label: 'Message', default: '' }],
	}),
	'feedback:internal:check_expression': createDefinition(EntityModelType.Feedback, {
		options: [{ id: 'expression', type: 'expression', label: 'Expression', default: 'true' }],
	}),
}

const eventDefinitions = {
	interval: {
		name: 'Interval',
		options: [{ id: 'seconds', type: 'number' as const, label: 'Seconds', min: 1, max: 3600, default: 10 }],
	},
	condition_true: { name: 'On condition becoming true', options: [] },
}

function createFixture() {
	const triggers = new Map<string, { model: TriggerModel; executeActions: ReturnType<typeof vi.fn> }>()

	const makeControl = (controlId: string) => {
		const entry = triggers.get(controlId)!
		return {
			controlId,
			type: 'trigger',
			options: entry.model.options,
			toJSON: () => structuredClone(entry.model),
			toTriggerJSON: () => ({
				...entry.model.options,
				type: 'trigger',
				description: entry.model.events.map((e) => e.type).join(', '),
				lastExecuted: null,
			}),
			executeActions: entry.executeActions,
		}
	}

	const deps: TriggersApiDeps = {
		controls: {
			getControl: (controlId: string) => (triggers.has(controlId) ? (makeControl(controlId) as any) : undefined),
			getAllTriggers: () => [...triggers.keys()].map((id) => makeControl(id) as any),
			importTrigger: (controlId: string, model: TriggerModel) => {
				if (triggers.has(controlId)) throw new Error(`Trigger ${controlId} already exists`)
				triggers.set(controlId, { model: structuredClone(model), executeActions: vi.fn() })
				return true
			},
			deleteControl: (controlId: string) => {
				triggers.delete(controlId)
			},
		},
		definitions: {
			getEntityDefinition: (entityType, connectionId, definitionId) =>
				definitions[`${entityType}:${connectionId}:${definitionId}`],
		},
		eventDefinitions,
		collections: { doesCollectionIdExist: (id) => !id || id === 'known' },
	}

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			controls: { createRestApiRouter: (logger) => createTriggersRestApiRouter(logger, deps) },
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
		{ token = tokens.write, ifMatch }: { token?: string; ifMatch?: string } = {}
	) => {
		let req = supertest(app)[method](`${TRIGGERS_PATH}${path}`).set('Authorization', `Bearer ${token}`)
		if (ifMatch) req = req.set('If-Match', ifMatch)
		return body ? req.send(body) : req
	}

	return { triggers, request }
}

const value = (v: unknown) => ({ isExpression: false, value: v })

const bridgeTrigger = {
	options: { name: 'Prompt submitted', enabled: true },
	events: [{ type: 'condition_true' }],
	condition: [
		{
			type: 'feedback',
			connectionId: 'internal',
			definitionId: 'check_expression',
			options: { expression: value("$(custom:submitted) == 'true'") },
		},
	],
	actions: [
		{ type: 'action', connectionId: 'internal', definitionId: 'custom_log', options: { message: value('hi') } },
	],
}

describe('Triggers REST API', () => {
	test('creates a trigger, completing defaults', async () => {
		const { request, triggers } = createFixture()
		const res = await request('post', '/', bridgeTrigger)

		expect(res.status).toBe(201)
		expect(res.headers.location).toBe(`${TRIGGERS_PATH}/${res.body.data.controlId}`)
		expect(res.body.data.controlId).toMatch(/^trigger:/)

		const model = triggers.get(res.body.data.controlId)!.model
		expect(model.options).toEqual({ name: 'Prompt submitted', enabled: true, sortOrder: 0, notes: '' })
		expect(model.events).toEqual([{ id: expect.any(String), type: 'condition_true', enabled: true, options: {} }])
		expect(model.localVariables).toEqual([])
	})

	test('new triggers are disabled by default and appended to the list', async () => {
		const { request, triggers } = createFixture()
		await request('post', '/', bridgeTrigger)
		const res = await request('post', '/', {})

		const model = triggers.get(res.body.data.controlId)!.model
		expect(model.options).toMatchObject({ name: 'New Trigger', enabled: false, sortOrder: 1 })
	})

	test('fills event option defaults', async () => {
		const { request, triggers } = createFixture()
		const res = await request('post', '/', { events: [{ type: 'interval' }] })

		expect(triggers.get(res.body.data.controlId)!.model.events[0].options).toEqual({ seconds: 10 })
	})

	test('reports every problem with a path, and creates nothing', async () => {
		const { request, triggers } = createFixture()
		const res = await request('post', '/', {
			events: [{ type: 'interval', options: { seconds: 'x', nope: 1 } }, { type: 'whenever' }],
			condition: [{ type: 'action', connectionId: 'internal', definitionId: 'custom_log', options: {} }],
			actions: [{ type: 'action', connectionId: 'internal', definitionId: 'nope', options: {} }],
		})

		expect(res.status).toBe(422)
		expect(res.body.error.details.errors.map((e: any) => `${e.path} ${e.code}`)).toEqual([
			'events[0].options.seconds invalid_value',
			'events[0].options.nope unknown_option',
			'events[1].type unknown_event_type',
			'condition[0].type wrong_entity_type',
			'actions[0] unknown_definition',
		])
		expect(triggers.size).toBe(0)
	})

	test('checks the collection exists', async () => {
		const { request } = createFixture()

		expect((await request('post', '/', { options: { collectionId: 'known' } })).status).toBe(201)
		const res = await request('post', '/', { options: { collectionId: 'nope' } })
		expect(res.status).toBe(422)
		expect(res.body.error.details.errors).toMatchObject([{ path: 'options.collectionId' }])
	})

	test('dryRun creates nothing', async () => {
		const { request, triggers } = createFixture()
		const res = await request('post', '/?dryRun=true', bridgeTrigger)

		expect(res.status).toBe(200)
		expect(res.body.data.controlId).toBeNull()
		expect(triggers.size).toBe(0)
	})

	test('lists triggers in order', async () => {
		const { request } = createFixture()
		await request('post', '/', { options: { name: 'B', sortOrder: 5 } })
		await request('post', '/', { options: { name: 'A', sortOrder: 1 } })

		const res = await request('get', '/', undefined, { token: tokens.read })
		expect(res.body.data.map((t: any) => t.name)).toEqual(['A', 'B'])
		expect(res.body.data[0]).toMatchObject({ enabled: false, collectionId: null, lastExecuted: null })
	})

	test('a GET then PUT of the same model keeps the id and ETag', async () => {
		const { request } = createFixture()
		const created = await request('post', '/', bridgeTrigger)
		const id = created.body.data.controlId
		const read = await request('get', `/${id}`)

		const res = await request('put', `/${id}`, read.body.data.model, { ifMatch: read.headers.etag })
		expect(res.status).toBe(200)
		expect(res.body.data.controlId).toBe(id)
		expect(res.headers.etag).toBe(read.headers.etag)
	})

	test('PUT and PATCH honour If-Match', async () => {
		const { request } = createFixture()
		const created = await request('post', '/', bridgeTrigger)
		const id = created.body.data.controlId

		expect((await request('put', `/${id}`, bridgeTrigger, { ifMatch: '"stale"' })).status).toBe(412)
		expect((await request('patch', `/${id}`, { options: {} }, { ifMatch: '"stale"' })).status).toBe(412)
		expect((await request('delete', `/${id}`, undefined, { ifMatch: '"stale"' })).status).toBe(412)
	})

	test('PATCH merges options and replaces lists', async () => {
		const { request, triggers } = createFixture()
		const created = await request('post', '/', bridgeTrigger)
		const id = created.body.data.controlId

		const res = await request('patch', `/${id}`, { options: { enabled: false }, actions: [] })

		expect(res.status).toBe(200)
		const model = triggers.get(id)!.model
		expect(model.options).toMatchObject({ name: 'Prompt submitted', enabled: false })
		expect(model.actions).toEqual([])
		expect(model.condition).toHaveLength(1)
	})

	test('404s for unknown and non-trigger ids', async () => {
		const { request } = createFixture()

		expect((await request('get', '/trigger:nope')).status).toBe(404)
		expect((await request('get', '/bank:abc')).status).toBe(404)
		expect((await request('put', '/trigger:nope', {})).status).toBe(404)
	})

	test('deletes a trigger', async () => {
		const { request, triggers } = createFixture()
		const created = await request('post', '/', bridgeTrigger)

		expect((await request('delete', `/${created.body.data.controlId}`)).status).toBe(204)
		expect(triggers.size).toBe(0)
	})

	test('test-fires the actions with the execute scope', async () => {
		const { request, triggers } = createFixture()
		const created = await request('post', '/', bridgeTrigger)
		const id = created.body.data.controlId

		expect((await request('post', `/${id}/test`)).status).toBe(403)
		expect((await request('post', `/${id}/test`, undefined, { token: tokens.execute })).status).toBe(204)
		expect(triggers.get(id)!.executeActions).toHaveBeenCalledWith(expect.any(Number), 'test')
	})
})
