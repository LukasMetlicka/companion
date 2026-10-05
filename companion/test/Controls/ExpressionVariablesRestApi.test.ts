import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType, FeedbackEntitySubType } from '../../../shared-lib/lib/Model/EntityModel.js'
import type { ExpressionVariableModel } from '../../../shared-lib/lib/Model/ExpressionVariableModel.js'
import {
	createExpressionVariablesRestApiRouter,
	EXPRESSION_VARIABLES_API_BASE_PATH,
	type ExpressionVariablesApiDeps,
} from '../../lib/Controls/ExpressionVariablesRestApi.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'

const { store: tokenStore, mint } = createTestTokenStore()
const writeToken = mint(['read', 'write'])

const PATH = `${REST_API_BASE_PATH}${EXPRESSION_VARIABLES_API_BASE_PATH}`

function createDefinition(feedbackType: FeedbackEntitySubType, options: ClientEntityDefinition['options']) {
	return {
		entityType: EntityModelType.Feedback,
		label: 'Test',
		sortKey: null,
		description: undefined,
		options,
		optionsToMonitorForInvalidations: null,
		feedbackType,
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
	} as ClientEntityDefinition
}

const definitions: Record<string, ClientEntityDefinition> = {
	'feedback:internal:expression_value': createDefinition(FeedbackEntitySubType.Value, [
		{ id: 'expression', type: 'expression', label: 'Expression', default: '' },
	]),
	'feedback:internal:check_expression': createDefinition(FeedbackEntitySubType.Boolean, []),
}

function createFixture() {
	const variables = new Map<string, ExpressionVariableModel>()

	const makeControl = (controlId: string) => {
		const model = variables.get(controlId)!
		return {
			controlId,
			type: 'expression-variable',
			options: model.options,
			toJSON: () => structuredClone(model),
			toClientJSON: () => ({ type: 'expression-variable', ...model.options, isActive: !!model.options.variableName }),
		}
	}

	const deps: ExpressionVariablesApiDeps = {
		controls: {
			getControl: (id: string) => (variables.has(id) ? (makeControl(id) as any) : undefined),
			getAllExpressionVariables: () => [...variables.keys()].map((id) => makeControl(id) as any),
			importExpressionVariable: (id: string, model: ExpressionVariableModel) => {
				if (variables.has(id)) throw new Error('exists')
				variables.set(id, structuredClone(model))
				return makeControl(id) as any
			},
			deleteControl: (id: string) => {
				variables.delete(id)
			},
		},
		definitions: {
			getEntityDefinition: (entityType, connectionId, definitionId) =>
				definitions[`${entityType}:${connectionId}:${definitionId}`],
		},
		values: { getVariableValue: (_label: string, name: string) => `value of ${name}` },
	}

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			controls: { createRestApiRouter: (logger) => createExpressionVariablesRestApiRouter(logger, deps) },
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
		ifMatch?: string
	) => {
		let req = supertest(app)[method](`${PATH}${path}`).set('Authorization', `Bearer ${writeToken}`)
		if (ifMatch) req = req.set('If-Match', ifMatch)
		return body ? req.send(body) : req
	}

	return { variables, request }
}

describe('Expression variables REST API', () => {
	test('creates from the expression shorthand', async () => {
		const { request, variables } = createFixture()
		const res = await request('post', '/', { options: { variableName: 'dit_label' }, expression: '1 + 2' })

		expect(res.status).toBe(201)
		expect(res.body.data).toMatchObject({ isActive: true, value: 'value of dit_label' })

		const model = variables.get(res.body.data.controlId)!
		expect(model.options).toMatchObject({ variableName: 'dit_label', sortOrder: 0 })
		expect(model.entity).toMatchObject({
			type: 'feedback',
			connectionId: 'internal',
			definitionId: 'expression_value',
			options: { expression: { isExpression: false, value: '1 + 2' } },
		})
	})

	test('requires a valid, unique name', async () => {
		const { request } = createFixture()

		expect((await request('post', '/', { expression: '1' })).status).toBe(422)
		expect((await request('post', '/', { options: { variableName: 'has space' }, expression: '1' })).status).toBe(422)

		await request('post', '/', { options: { variableName: 'taken' }, expression: '1' })
		expect((await request('post', '/', { options: { variableName: 'taken' }, expression: '2' })).status).toBe(409)
	})

	test('the root entity must be a value feedback', async () => {
		const { request } = createFixture()
		const res = await request('post', '/', {
			options: { variableName: 'x' },
			entity: { type: 'feedback', connectionId: 'internal', definitionId: 'check_expression', options: {} },
		})

		expect(res.status).toBe(422)
		expect(res.body.error.details.errors).toMatchObject([{ path: 'entity', code: 'wrong_entity_type' }])
	})

	test('rejects expression together with entity', async () => {
		const { request } = createFixture()
		const res = await request('post', '/', {
			options: { variableName: 'x' },
			expression: '1',
			entity: null,
		})
		expect(res.status).toBe(400)
	})

	test('PATCH can rename to its own name and replace the expression', async () => {
		const { request, variables } = createFixture()
		const created = await request('post', '/', { options: { variableName: 'v' }, expression: '1' })
		const id = created.body.data.controlId

		const res = await request('patch', `/${id}`, { options: { variableName: 'v' }, expression: '2' })
		expect(res.status).toBe(200)
		expect((variables.get(id)!.entity!.options as any).expression.value).toBe('2')
	})

	test('a GET then PUT of the same model keeps the ETag, and If-Match is enforced', async () => {
		const { request } = createFixture()
		const created = await request('post', '/', { options: { variableName: 'v' }, expression: '1' })
		const id = created.body.data.controlId
		const read = await request('get', `/${id}`)

		const { type: _type, ...model } = read.body.data.model
		const res = await request('put', `/${id}`, model, read.headers.etag)
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBe(read.headers.etag)

		expect((await request('put', `/${id}`, model, '"stale"')).status).toBe(412)
	})

	test('lists, and deletes', async () => {
		const { request, variables } = createFixture()
		const created = await request('post', '/', { options: { variableName: 'v' }, expression: '1' })

		const list = await request('get', '/')
		expect(list.body.data).toMatchObject([{ variableName: 'v', isActive: true, value: 'value of v' }])

		expect((await request('delete', `/${created.body.data.controlId}`)).status).toBe(204)
		expect(variables.size).toBe(0)
		expect((await request('get', `/${created.body.data.controlId}`)).status).toBe(404)
	})
})
