import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import z from 'zod'
import { CreatePageControlId } from '@companion-app/shared/ControlId.js'
import type { PageControlModel } from '@companion-app/shared/Model/PageControlModel.js'
import type { Logger } from '../Log/Controller.js'
import type { IPageStore } from '../Page/Store.js'
import { RestApiError } from '../Service/RestApi/errors.js'
import { checkIfMatch, computeEtag } from '../Service/RestApi/etag.js'
import {
	createSuccessSchema,
	errorResponses,
	ErrorResponseSchema,
	successResponse,
} from '../Service/RestApi/schemas/common.js'
import {
	createRestEndpointSpecFactory,
	mountRestEndpoint,
	registerRestEndpoint,
	type RestEndpointSpec,
} from '../Service/RestApi/typedRoute.js'
import type { ControlsController } from './Controller.js'
import {
	preparePageVariables,
	stripPageVariableIds,
	type ControlModelValidatorDeps,
	type ControlModelWarning,
} from './ControlModelValidator.js'
import { EntitySchema, normalizeEntities } from './ControlsRestApi.js'

/** Mounted under the pages resource: /api/v2/pages/v1/:pageId/variables */
export const PAGE_VARIABLES_API_BASE_PATH = '/pages/v1'
const PAGE_VARIABLES_API_TAGS = ['Pages']

export interface PageVariablesApiDeps {
	controls: Pick<ControlsController, 'getControl' | 'createPageControl'>
	pageStore: Pick<IPageStore, 'isPageIdValid'>
	definitions: ControlModelValidatorDeps
}

type PageVariablesRestContext = PageVariablesApiDeps & { logger: Logger }

const definePageVariablesEndpointSpec = createRestEndpointSpecFactory<PageVariablesRestContext>()

const PutBodySchema = z
	.object({
		localVariables: z
			.array(EntitySchema)
			.describe(
				'The page variables: value feedbacks, each with a variableName (used as $(page:<name>)), e.g. internal user_value or expression_value. Replaces all of them.'
			),
	})
	.strict()

const WriteQuerySchema = z.object({
	dryRun: z
		.enum(['true', 'false'])
		.optional()
		.describe('If true, validate and return the resulting variables without writing anything.'),
	allowMissingDefinitions: z
		.enum(['true', 'false'])
		.optional()
		.describe('If true, entities of connections that are not running are accepted with a warning.'),
})

const pageIdParam = z.object({
	pageId: z.string().describe('Page id.').meta({ example: 'ggmHXCUQ0RRXUwEr8HHtQ' }),
})

const ResponseExample = { pageId: 'ggmHXCUQ0RRXUwEr8HHtQ', localVariables: [], warnings: [] }

const PageVariablesResponseSchema = z
	.object({
		pageId: z.string(),
		localVariables: z
			.array(z.object({ type: z.string() }).catchall(z.unknown()))
			.describe('The page variables as Companion stores them. Writable as-is with PUT.'),
		warnings: z.array(z.object({ path: z.string(), message: z.string() })),
	})
	.meta({ example: ResponseExample })

type PageVariablesResponse = z.infer<typeof PageVariablesResponseSchema>

/**
 * Create the page variables router for /api/v2/pages/v1/:pageId/variables
 */
export function createPageVariablesRestApiRouter(logger: Logger, deps: PageVariablesApiDeps): Express.Router {
	const innerRouter = Express.Router()
	const context: PageVariablesRestContext = { ...deps, logger: logger.child({ source: 'pages/v1/variables' }) }

	for (const endpointSpec of pageVariablesEndpointSpecs) {
		mountRestEndpoint(innerRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(PAGE_VARIABLES_API_BASE_PATH, innerRouter)

	return router
}

export function registerPageVariablesPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of pageVariablesEndpointSpecs) {
		registerRestEndpoint(registry, PAGE_VARIABLES_API_BASE_PATH, endpointSpec.contract)
	}
}

function getModelOrThrow(ctx: PageVariablesRestContext, pageId: string): PageControlModel {
	if (!ctx.pageStore.isPageIdValid(pageId)) throw RestApiError.notFound('Page not found')

	const control = ctx.controls.getControl(CreatePageControlId(pageId))
	// Every page has its page control; treat a missing one as having no variables
	return control ? (control.toJSON(true) as PageControlModel) : { type: 'page', localVariables: [] }
}

function buildResponse(
	pageId: string,
	model: PageControlModel,
	warnings: ControlModelWarning[] = []
): { body: { data: PageVariablesResponse }; etag: string } {
	return {
		body: successResponse({
			pageId,
			localVariables: model.localVariables as unknown as PageVariablesResponse['localVariables'],
			warnings,
		}),
		etag: computeEtag(stripPageVariableIds(model)),
	}
}

const pageVariablesEndpointSpecs: RestEndpointSpec<PageVariablesRestContext>[] = [
	definePageVariablesEndpointSpec(
		{
			method: 'get',
			path: '/:pageId/variables',
			scopes: ['read'],
			tags: PAGE_VARIABLES_API_TAGS,
			summary: 'Get the variables of a page',
			description:
				'Returns the page variables (available to every button on the page as $(page:<name>)). The ETag header identifies this version.',
			request: { params: pageIdParam },
			response: {
				status: 200,
				description: 'The page variables',
				schema: createSuccessSchema(PageVariablesResponseSchema),
			},
			examples: { response: successResponse(ResponseExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				const { body, etag } = buildResponse(params.pageId, getModelOrThrow(ctx, params.pageId))
				return { body, headers: { ETag: etag } }
			}
		}
	),

	definePageVariablesEndpointSpec(
		{
			method: 'put',
			path: '/:pageId/variables',
			scopes: ['write'],
			tags: PAGE_VARIABLES_API_TAGS,
			summary: 'Replace the variables of a page',
			description:
				'Replace all page variables. Each must be a value feedback with a valid, unique variableName. Send If-Match to only replace a version you have seen.',
			request: { params: pageIdParam, query: WriteQuerySchema, body: PutBodySchema },
			response: {
				status: 200,
				description: 'The written page variables',
				schema: createSuccessSchema(PageVariablesResponseSchema),
			},
			examples: { response: successResponse(ResponseExample) },
			extraResponses: {
				412: {
					description: 'If-Match does not match the current ETag',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				422: {
					description: 'The variables are not valid; details lists each problem with its path',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
			errorResponses,
		},
		(ctx) => {
			return ({ params, query, body, headers }) => {
				const current = getModelOrThrow(ctx, params.pageId)
				checkIfMatch(headers, computeEtag(stripPageVariableIds(current)))

				const prepared = preparePageVariables(
					normalizeEntities(body.localVariables, 'localVariables'),
					ctx.definitions,
					{
						allowMissingDefinitions: query.allowMissingDefinitions === 'true',
					}
				)
				if (prepared.errors.length > 0) {
					throw RestApiError.unprocessable('Page variables are not valid', {
						errors: prepared.errors,
						warnings: prepared.warnings,
					})
				}

				if (query.dryRun === 'true') {
					const { body: responseBody, etag } = buildResponse(params.pageId, prepared.model, prepared.warnings)
					return { body: responseBody, headers: { ETag: etag } }
				}

				ctx.controls.createPageControl(params.pageId, prepared.model, true)
				ctx.logger.info(`Replaced the variables of page ${params.pageId}`)

				const { body: responseBody, etag } = buildResponse(
					params.pageId,
					getModelOrThrow(ctx, params.pageId),
					prepared.warnings
				)
				return { body: responseBody, headers: { ETag: etag } }
			}
		}
	),
]
