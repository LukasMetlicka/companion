import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType, FeedbackEntitySubType } from '../../../shared-lib/lib/Model/EntityModel.js'
import type { PageControlModel } from '../../../shared-lib/lib/Model/PageControlModel.js'
import { createPageVariablesRestApiRouter, type PageVariablesApiDeps } from '../../lib/Controls/PageVariablesRestApi.js'
import { REST_API_BASE_PATH } from '../../lib/Service/RestApi/constants.js'
import { createRestApiRouter } from '../../lib/Service/RestApi/RestApiRouter.js'
import {
	createTestEnabledUserConfig,
	createTestRestApiResources,
	createTestTokenStore,
} from '../Service/RestApi/RestApiTestHelpers.js'

const { store: tokenStore, mint } = createTestTokenStore()
const tokens = { read: mint(['read']), write: mint(['read', 'write']) }

const PAGE_ID = 'page-a'
const PATH = `${REST_API_BASE_PATH}/pages/v1/${PAGE_ID}/variables`

function createDefinition(feedbackType: FeedbackEntitySubType): ClientEntityDefinition {
	return {
		entityType: EntityModelType.Feedback,
		label: 'Test',
		sortKey: null,
		description: undefined,
		options: [{ id: 'expression', type: 'expression', label: 'Expression', default: '' }],
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
	}
}

const definitions: Record<string, ClientEntityDefinition> = {
	'feedback:internal:expression_value': createDefinition(FeedbackEntitySubType.Value),
	'feedback:internal:check_expression': createDefinition(FeedbackEntitySubType.Boolean),
}

function createFixture() {
	const pageControls = new Map<string, PageControlModel>()

	const deps: PageVariablesApiDeps = {
		controls: {
			getControl: (controlId: string) => {
				const model = pageControls.get(controlId)
				return model ? ({ toJSON: () => structuredClone(model) } as any) : undefined
			},
			createPageControl: (pageId: string, storage?: PageControlModel | null) => {
				pageControls.set(`page:${pageId}`, structuredClone(storage ?? { type: 'page', localVariables: [] }))
				return `page:${pageId}`
			},
		},
		pageStore: { isPageIdValid: (pageId: string) => pageId === PAGE_ID },
		definitions: {
			getEntityDefinition: (entityType, connectionId, definitionId) =>
				definitions[`${entityType}:${connectionId}:${definitionId}`],
		},
	}

	const restApiRouter = createRestApiRouter(
		createTestRestApiResources({
			controls: { createRestApiRouter: (logger) => createPageVariablesRestApiRouter(logger, deps) },
		}),
		createTestEnabledUserConfig(),
		tokenStore,
		{ appVersion: '5.0.0-test' }
	)
	const app = express()
	app.use(express.json())
	app.use(REST_API_BASE_PATH, restApiRouter)

	const put = (body: object, { token = tokens.write, ifMatch, query = '' } = {} as any) => {
		let req = supertest(app).put(`${PATH}${query}`).set('Authorization', `Bearer ${token}`)
		if (ifMatch) req = req.set('If-Match', ifMatch)
		return req.send(body)
	}
	const get = (path = PATH) => supertest(app).get(path).set('Authorization', `Bearer ${tokens.read}`)

	return { pageControls, put, get }
}

const variable = (variableName: string | undefined, definitionId = 'expression_value') => ({
	type: 'feedback',
	connectionId: 'internal',
	definitionId,
	...(variableName ? { variableName } : {}),
	options: { expression: { isExpression: false, value: '"DIT"' } },
})

describe('Page variables REST API', () => {
	test('reads an empty page and 404s an unknown page', async () => {
		const { get } = createFixture()

		expect((await get()).body.data).toEqual({ pageId: PAGE_ID, localVariables: [], warnings: [] })
		expect((await get(`${REST_API_BASE_PATH}/pages/v1/nope/variables`)).status).toBe(404)
	})

	test('replaces the variables of a page', async () => {
		const { put, pageControls } = createFixture()
		const res = await put({ localVariables: [variable('role')] })

		expect(res.status).toBe(200)
		expect(pageControls.get(`page:${PAGE_ID}`)!.localVariables).toMatchObject([{ variableName: 'role' }])
	})

	test('validates type, names and uniqueness', async () => {
		const { put, pageControls } = createFixture()
		const res = await put({
			localVariables: [variable('a', 'check_expression'), variable(undefined), variable('role'), variable('role')],
		})

		expect(res.status).toBe(422)
		expect(res.body.error.details.errors.map((e: any) => e.path)).toEqual([
			'localVariables[0]',
			'localVariables[1].variableName',
			'localVariables[3].variableName',
		])
		expect(pageControls.size).toBe(0)
	})

	test('a GET then PUT keeps the ETag; If-Match and dryRun are honoured', async () => {
		const { put, get, pageControls } = createFixture()
		await put({ localVariables: [variable('role')] })
		const read = await get()

		const res = await put({ localVariables: read.body.data.localVariables }, { ifMatch: read.headers.etag })
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBe(read.headers.etag)

		expect((await put({ localVariables: [] }, { ifMatch: '"stale"' })).status).toBe(412)

		expect((await put({ localVariables: [] }, { query: '?dryRun=true' })).status).toBe(200)
		expect(pageControls.get(`page:${PAGE_ID}`)!.localVariables).toHaveLength(1)
	})

	test('read tokens cannot write', async () => {
		const { put } = createFixture()
		expect((await put({ localVariables: [] }, { token: tokens.read })).status).toBe(403)
	})
})
