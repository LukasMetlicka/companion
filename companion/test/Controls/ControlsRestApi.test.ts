import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import type { SomeButtonModel } from '../../../shared-lib/lib/Model/ButtonModel.js'
import type { ControlLocation } from '../../../shared-lib/lib/Model/Common.js'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType } from '../../../shared-lib/lib/Model/EntityModel.js'
import {
	CONTROLS_API_BASE_PATH,
	createControlsRestApiRouter,
	type ControlsApiDeps,
} from '../../lib/Controls/ControlsRestApi.js'
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

const CONTROLS_PATH = `${REST_API_BASE_PATH}${CONTROLS_API_BASE_PATH}`

function createDefinition(entityType: EntityModelType, props: Partial<ClientEntityDefinition>): ClientEntityDefinition {
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
	'action:kumo:route': createDefinition(EntityModelType.Action, {
		options: [{ id: 'source', type: 'number', label: 'Source', default: 1, min: 1, max: 64 }],
	}),
	'action:internal:logic_if': createDefinition(EntityModelType.Action, {
		supportsChildGroups: [
			{ type: EntityModelType.Feedback, groupId: 'condition', entityTypeLabel: 'condition', label: 'Condition' },
			{ type: EntityModelType.Action, groupId: 'actions', entityTypeLabel: 'action', label: 'Then' },
		],
	}),
	'feedback:kumo:routed': createDefinition(EntityModelType.Feedback, {}),
}

const PAGE_ID = 'page-a'

/** An in-memory stand-in for the controls, pages and definitions the resource drives */
function createFixture() {
	const models = new Map<string, SomeButtonModel>()
	const grid = new Map<string, string>()
	const locationKey = (l: ControlLocation) => `${l.pageNumber}/${l.row}/${l.column}`
	const presses: Array<[string, boolean, string | undefined]> = []
	let nextId = 1

	const deps: ControlsApiDeps = {
		controls: {
			getControl: (controlId: string) => {
				const model = models.get(controlId)
				return model ? ({ toJSON: () => structuredClone(model) } as any) : undefined
			},
			importControl: (location: ControlLocation, definition: SomeButtonModel, forceControlId?: string) => {
				const old = grid.get(locationKey(location))
				if (old) models.delete(old)
				const controlId = forceControlId ?? `bank:new${nextId++}`
				// Like Companion, regenerate entity ids on import
				models.set(controlId, JSON.parse(JSON.stringify(definition).replace(/"id":"[^"]*-ent"/g, '"id":"regen"')))
				grid.set(locationKey(location), controlId)
				return controlId
			},
			deleteControl: (controlId: string) => {
				models.delete(controlId)
				for (const [key, id] of grid) if (id === controlId) grid.delete(key)
			},
			pressControl: (controlId: string, pressed: boolean, surfaceId: string | undefined) => {
				presses.push([controlId, pressed, surfaceId])
				return true
			},
			rotateControl: () => true,
		},
		pageStore: {
			getPageNumber: (pageId: string) => (pageId === PAGE_ID ? 1 : null),
			getPageId: (pageNumber: number) => (pageNumber === 1 ? PAGE_ID : undefined),
			// Companion returns undefined for an empty location, despite the declared type
			getControlIdAt: (location: ControlLocation) => grid.get(locationKey(location)) as string,
			getLocationOfControlId: (controlId: string) => {
				for (const [key, id] of grid) {
					if (id === controlId) {
						const [pageNumber, row, column] = key.split('/').map(Number)
						return { pageNumber, row, column }
					}
				}
				return undefined
			},
		},
		definitions: {
			getEntityDefinition: (entityType, connectionId, definitionId) =>
				definitions[`${entityType}:${connectionId}:${definitionId}`],
		},
		userconfig: { getKey: () => ({ minColumn: 0, maxColumn: 7, minRow: 0, maxRow: 3 }) },
	}

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			controls: { createRestApiRouter: (logger) => createControlsRestApiRouter(logger, deps) },
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
		let req = supertest(app)[method](`${CONTROLS_PATH}${path}`).set('Authorization', `Bearer ${token}`)
		if (ifMatch) req = req.set('If-Match', ifMatch)
		return body ? req.send(body) : req
	}

	return { models, grid, presses, request }
}

const value = (v: unknown) => ({ isExpression: false, value: v })

const routeButton = {
	type: 'button-layered',
	style: {
		layers: [
			{ id: 'canvas', type: 'canvas' },
			{ id: 'label', type: 'text', text: value('CAM 1') },
		],
	},
	feedbacks: [{ type: 'feedback', connectionId: 'kumo', definitionId: 'routed', options: {} }],
	steps: {
		0: {
			action_sets: {
				down: [{ type: 'action', connectionId: 'kumo', definitionId: 'route', options: { source: value(3) } }],
				up: [],
			},
		},
	},
}

describe('Controls REST API', () => {
	describe('PUT /locations/:pageId/:row/:column', () => {
		test('creates a layered button, completing defaults', async () => {
			const { request, models } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)

			expect(res.status).toBe(201)
			expect(res.headers.etag).toMatch(/^"[\w-]+"$/)
			expect(res.headers.location).toBe(`${CONTROLS_PATH}/${res.body.data.controlId}`)
			expect(res.body.data.location).toEqual({ pageId: PAGE_ID, pageNumber: 1, row: 1, column: 2 })

			const model = models.get(res.body.data.controlId) as any
			expect(model.options).toMatchObject({ stepProgression: 'auto', rotaryActions: false })
			expect(model.localVariables).toEqual([])
			// The text element was completed with the defaults for its type
			expect(model.style.layers[1]).toMatchObject({ id: 'label', name: 'Text', text: value('CAM 1') })
			expect(model.style.layers[1].fontsize).toBeDefined()
			// Entities get ids
			expect(typeof model.feedbacks[0].id).toBe('string')
		})

		test('uses the default style and one empty step for a bare layered button', async () => {
			const { request, models } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/0/0`, { type: 'button-layered' })

			const model = models.get(res.body.data.controlId) as any
			expect(model.style.layers[0].type).toBe('canvas')
			expect(model.steps).toEqual({ 0: { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } } })
		})

		test('replacing keeps the control id', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const replaced = await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup' })

			expect(replaced.status).toBe(200)
			expect(replaced.body.data.controlId).toBe(created.body.data.controlId)
			expect(replaced.body.data.model).toEqual({ type: 'pageup' })
		})

		test('a GET then PUT of the same model keeps the ETag', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const read = await request('get', `/${created.body.data.controlId}`)

			const rewritten = await request('put', `/locations/${PAGE_ID}/1/2`, read.body.data.model, {
				ifMatch: read.headers.etag,
			})
			expect(rewritten.status).toBe(200)
			expect(rewritten.headers.etag).toBe(read.headers.etag)
		})

		test('rejects a stale If-Match without writing', async () => {
			const { request, models } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)

			const res = await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup' }, { ifMatch: '"stale"' })
			expect(res.status).toBe(412)
			expect(res.body.error.details.currentEtag).toBe(created.headers.etag)
			expect(models.get(created.body.data.controlId)?.type).toBe('button-layered')
		})

		test('If-Match * requires an existing control', async () => {
			const { request } = createFixture()
			expect((await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup' }, { ifMatch: '*' })).status).toBe(412)
		})

		test('reports every problem with a path, and writes nothing', async () => {
			const { request, grid } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/1/2`, {
				type: 'button-layered',
				style: {
					layers: [
						{ id: 'label', type: 'text', txt: value('x') },
						{ id: 'c', type: 'canvas' },
					],
				},
				feedbacks: [{ type: 'action', connectionId: 'kumo', definitionId: 'route', options: {} }],
				steps: {
					0: {
						action_sets: {
							down: [
								{ type: 'action', connectionId: 'kumo', definitionId: 'route', options: { source: value(99) } },
								{ type: 'action', connectionId: 'kumo', definitionId: 'nope', options: {} },
							],
						},
					},
				},
			})

			expect(res.status).toBe(422)
			expect(res.body.error.details.errors.map((e: any) => `${e.path} ${e.code}`)).toEqual([
				'style.layers invalid_layers',
				'style.layers[0].txt unknown_element_property',
				'style.layers[1] invalid_layers',
				'feedbacks[0].type wrong_entity_type',
				'steps.0.action_sets.down[0].options.source invalid_value',
				'steps.0.action_sets.down[1] unknown_definition',
			])
			expect(grid.size).toBe(0)
		})

		test('validates children of logic entities against their child group', async () => {
			const { request } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/1/2`, {
				type: 'button-layered',
				steps: {
					0: {
						action_sets: {
							down: [
								{
									type: 'action',
									connectionId: 'internal',
									definitionId: 'logic_if',
									options: {},
									children: {
										condition: [{ type: 'feedback', connectionId: 'kumo', definitionId: 'routed', options: {} }],
										actions: [
											{ type: 'action', connectionId: 'kumo', definitionId: 'route', options: { source: value(0) } },
										],
										otherwise: [],
									},
								},
							],
						},
					},
				},
			})

			expect(res.status).toBe(422)
			expect(res.body.error.details.errors.map((e: any) => `${e.path} ${e.code}`)).toEqual([
				'steps.0.action_sets.down[0].children.actions[0].options.source invalid_value',
				'steps.0.action_sets.down[0].children.otherwise unknown_child_group',
			])
		})

		test('checks feedback style overrides point at a real element property', async () => {
			const { request } = createFixture()
			const override = (elementId: string, elementProperty: string) => ({
				type: 'feedback',
				connectionId: 'kumo',
				definitionId: 'routed',
				options: {},
				styleOverrides: [{ overrideId: 'o1', elementId, elementProperty, override: value(0xff0000) }],
			})

			const res = await request('put', `/locations/${PAGE_ID}/1/2`, {
				...routeButton,
				feedbacks: [override('label', 'color'), override('nope', 'color'), override('label', 'colour')],
			})

			expect(res.status).toBe(422)
			expect(res.body.error.details.errors.map((e: any) => e.path)).toEqual([
				'feedbacks[1].styleOverrides[0].elementId',
				'feedbacks[2].styleOverrides[0].elementProperty',
			])
		})

		test('allowMissingDefinitions downgrades unknown definitions to warnings', async () => {
			const { request } = createFixture()
			const body = {
				type: 'button-layered',
				feedbacks: [{ type: 'feedback', connectionId: 'stopped', definitionId: 'x', options: {} }],
			}

			expect((await request('put', `/locations/${PAGE_ID}/1/2`, body)).status).toBe(422)

			const res = await request('put', `/locations/${PAGE_ID}/1/2?allowMissingDefinitions=true`, body)
			expect(res.status).toBe(201)
			expect(res.body.data.warnings).toMatchObject([{ path: 'feedbacks[0]' }])
		})

		test('dryRun returns the completed model without writing', async () => {
			const { request, grid } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/1/2?dryRun=true`, routeButton)

			expect(res.status).toBe(200)
			expect(res.body.data.controlId).toBeNull()
			expect(res.body.data.model.style.layers[1].fontsize).toBeDefined()
			expect(grid.size).toBe(0)
		})

		test('rejects bad locations and shapes', async () => {
			const { request } = createFixture()

			expect((await request('put', `/locations/nope/1/2`, { type: 'pageup' })).status).toBe(404)
			expect((await request('put', `/locations/${PAGE_ID}/9/2`, { type: 'pageup' })).status).toBe(400)
			expect((await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'preset-reference' })).status).toBe(400)
			expect((await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup', extra: 1 })).status).toBe(400)
		})

		test('read tokens cannot write', async () => {
			const { request } = createFixture()
			const res = await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup' }, { token: tokens.read })
			expect(res.status).toBe(403)
		})
	})

	describe('GET', () => {
		test('reads by id and by location with the same ETag', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)

			const byId = await request('get', `/${created.body.data.controlId}`, undefined, { token: tokens.read })
			const byLocation = await request('get', `/locations/${PAGE_ID}/1/2`, undefined, { token: tokens.read })

			expect(byId.status).toBe(200)
			expect(byLocation.body).toEqual(byId.body)
			expect(byLocation.headers.etag).toBe(byId.headers.etag)
			expect(byId.headers.etag).toBe(created.headers.etag)
		})

		test('404s for empty locations and non-grid control ids', async () => {
			const { request } = createFixture()

			expect((await request('get', `/locations/${PAGE_ID}/1/2`)).status).toBe(404)
			expect((await request('get', `/trigger:abc`)).status).toBe(404)
			expect((await request('get', `/bank:missing`)).status).toBe(404)
		})
	})

	describe('PATCH /:controlId', () => {
		test('merges options and replaces lists', async () => {
			const { request, models } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			const res = await request('patch', `/${id}`, { options: { notes: 'planter' }, feedbacks: [] })

			expect(res.status).toBe(200)
			const model = models.get(id) as any
			expect(model.options).toMatchObject({ notes: 'planter', stepProgression: 'auto' })
			expect(model.feedbacks).toEqual([])
			expect(model.steps['0'].action_sets.down).toHaveLength(1)
			expect(res.headers.etag).not.toBe(created.headers.etag)
		})

		test('works when the stored model has empty (undefined) action sets', async () => {
			const { request, models } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId
			// Companion leaves unused action sets undefined
			;(models.get(id) as any).steps['0'].action_sets.rotate_left = undefined

			const res = await request('patch', `/${id}`, { options: { notes: 'x' } })
			expect(res.status).toBe(200)
		})

		test('validates the patched model', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)

			const res = await request('patch', `/${created.body.data.controlId}`, {
				feedbacks: [{ type: 'feedback', connectionId: 'kumo', definitionId: 'nope', options: {} }],
			})
			expect(res.status).toBe(422)
		})

		test('dryRun does not write', async () => {
			const { request, models } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			const res = await request('patch', `/${id}?dryRun=true`, { options: { notes: 'x' } })
			expect(res.status).toBe(200)
			expect(res.body.data.model.options.notes).toBe('x')
			expect((models.get(id) as any).options.notes).toBeUndefined()
		})

		test('only patches layered buttons', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, { type: 'pageup' })

			expect((await request('patch', `/${created.body.data.controlId}`, { options: {} })).status).toBe(409)
		})

		test('honours If-Match', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			expect((await request('patch', `/${id}`, { options: {} }, { ifMatch: '"stale"' })).status).toBe(412)
			expect((await request('patch', `/${id}`, { options: {} }, { ifMatch: created.headers.etag })).status).toBe(200)
		})
	})

	describe('DELETE /:controlId', () => {
		test('deletes, honouring If-Match', async () => {
			const { request, grid } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			expect((await request('delete', `/${id}`, undefined, { ifMatch: '"stale"' })).status).toBe(412)
			expect((await request('delete', `/${id}`, undefined, { ifMatch: created.headers.etag })).status).toBe(204)
			expect(grid.size).toBe(0)
		})
	})

	describe('press, down, up, rotate', () => {
		test('press runs down then up, attributed to a surface', async () => {
			const { request, presses } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			expect(
				(await request('post', `/${id}/press`, { surfaceId: 'streamdeck:1' }, { token: tokens.execute })).status
			).toBe(204)
			expect((await request('post', `/${id}/down`, undefined, { token: tokens.execute })).status).toBe(204)
			expect((await request('post', `/${id}/up`, undefined, { token: tokens.execute })).status).toBe(204)

			expect(presses).toEqual([
				[id, true, 'streamdeck:1'],
				[id, false, 'streamdeck:1'],
				[id, true, undefined],
				[id, false, undefined],
			])
		})

		test('needs the execute scope', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)

			expect((await request('post', `/${created.body.data.controlId}/press`)).status).toBe(403)
		})

		test('rotate validates the direction', async () => {
			const { request } = createFixture()
			const created = await request('put', `/locations/${PAGE_ID}/1/2`, routeButton)
			const id = created.body.data.controlId

			expect((await request('post', `/${id}/rotate`, { direction: 'left' }, { token: tokens.execute })).status).toBe(
				204
			)
			expect((await request('post', `/${id}/rotate`, { direction: 'up' }, { token: tokens.execute })).status).toBe(400)
		})
	})
})
