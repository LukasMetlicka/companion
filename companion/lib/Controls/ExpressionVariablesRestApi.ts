import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import { nanoid } from 'nanoid'
import z from 'zod'
import { CreateExpressionVariableControlId } from '@companion-app/shared/ControlId.js'
import { isLabelValid } from '@companion-app/shared/Label.js'
import { EntityModelType, type SomeEntityModel } from '@companion-app/shared/Model/EntityModel.js'
import type { ExpressionVariableModel } from '@companion-app/shared/Model/ExpressionVariableModel.js'
import type { Logger } from '../Log/Controller.js'
import { REST_API_BASE_PATH } from '../Service/RestApi/constants.js'
import { RestApiError } from '../Service/RestApi/errors.js'
import { checkIfMatch, computeEtag } from '../Service/RestApi/etag.js'
import {
	collectionResponse,
	createCollectionSchema,
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
import type { VariablesValues } from '../Variables/Values.js'
import type { ControlsController } from './Controller.js'
import {
	prepareExpressionVariableModel,
	stripExpressionVariableIds,
	type ControlModelValidatorDeps,
	type ControlModelWarning,
} from './ControlModelValidator.js'
import { EntitySchema, normalizeEntities } from './ControlsRestApi.js'
import type { ControlExpressionVariable } from './ControlTypes/ExpressionVariable.js'
import { validateExpressionVariableControlId } from './Util.js'

export const EXPRESSION_VARIABLES_API_BASE_PATH = '/variables/v1/expression'
const EXPRESSION_VARIABLES_API_TAGS = ['Variables']

export interface ExpressionVariablesApiDeps {
	controls: Pick<
		ControlsController,
		'getControl' | 'getAllExpressionVariables' | 'importExpressionVariable' | 'deleteControl'
	>
	definitions: ControlModelValidatorDeps
	values: Pick<VariablesValues, 'getVariableValue'>
}

type ExpressionVariablesRestContext = ExpressionVariablesApiDeps & { logger: Logger }

const defineExpressionVariableEndpointSpec = createRestEndpointSpecFactory<ExpressionVariablesRestContext>()

// ---- Request schemas ----

const OptionsSchema = z
	.object({
		variableName: z.string().optional().describe('Name, referenced as $(expression:<name>). Must be unique.'),
		description: z.string().optional(),
		sortOrder: z.number().optional().describe('Position in the list. Defaults to the end.'),
		collectionId: z.string().optional(),
		notes: z.string().optional(),
	})
	.strict()

const ExpressionVariableInputSchema = z
	.object({
		type: z.literal('expression-variable').optional(),
		options: OptionsSchema.optional(),
		entity: EntitySchema.nullable()
			.optional()
			.describe('The value feedback that computes the value. Use expression instead for a plain expression.'),
		expression: z
			.string()
			.optional()
			.describe(
				'Shorthand for an entity that evaluates this expression (internal expression_value). Not allowed together with entity.'
			),
		localVariables: z.array(EntitySchema).optional(),
	})
	.strict()

const WriteQuerySchema = z.object({
	dryRun: z
		.enum(['true', 'false'])
		.optional()
		.describe('If true, validate and return the resulting model without writing anything.'),
	allowMissingDefinitions: z
		.enum(['true', 'false'])
		.optional()
		.describe('If true, entities of connections that are not running are accepted with a warning.'),
})

const controlIdParam = z.object({
	controlId: z.string().describe('Expression variable id.').meta({ example: 'expression-variable:Rk2pV8xQ1mZ4' }),
})

// ---- Response schemas ----

const SummaryExample = {
	controlId: 'expression-variable:Rk2pV8xQ1mZ4',
	variableName: 'dit_route_label',
	description: 'Label for the DIT route button',
	isActive: true,
	sortOrder: 0,
	collectionId: null,
}

const SummaryResponseSchema = z
	.object({
		controlId: z.string(),
		variableName: z.string(),
		description: z.string(),
		isActive: z
			.boolean()
			.describe('False if another expression variable with the same name takes precedence, or the name is empty.'),
		sortOrder: z.number(),
		collectionId: z.string().nullable(),
		value: z.unknown().optional().describe('Current value, as $(expression:<name>). Omitted if unset or inactive.'),
	})
	.meta({ example: SummaryExample })

const ResponseExample = {
	controlId: SummaryExample.controlId,
	model: {
		type: 'expression-variable' as const,
		options: { variableName: 'dit_route_label', description: '', sortOrder: 0, notes: '' },
		entity: null,
		localVariables: [],
	},
	isActive: true,
	warnings: [],
}

const ExpressionVariableResponseSchema = z
	.object({
		controlId: z.string().nullable().describe('Id; null in a dry run that would create one.'),
		model: z
			.object({ type: z.literal('expression-variable') })
			.catchall(z.unknown())
			.describe('The model as Companion stores it. Writable as-is with PUT.'),
		isActive: z.boolean(),
		value: z.unknown().optional().describe('Current value. Omitted if unset or inactive.'),
		warnings: z.array(z.object({ path: z.string(), message: z.string() })),
	})
	.meta({ example: ResponseExample })

type ExpressionVariableResponse = z.infer<typeof ExpressionVariableResponseSchema>

const extraWriteResponses = {
	409: {
		description: 'Another expression variable already has this name',
		content: { 'application/json': { schema: ErrorResponseSchema } },
	},
	412: {
		description: 'If-Match does not match the current ETag',
		content: { 'application/json': { schema: ErrorResponseSchema } },
	},
	422: {
		description: 'The model is not valid; details lists each problem with its path',
		content: { 'application/json': { schema: ErrorResponseSchema } },
	},
}

/**
 * Create the expression variables router for /api/v2/variables/v1/expression
 */
export function createExpressionVariablesRestApiRouter(
	logger: Logger,
	deps: ExpressionVariablesApiDeps
): Express.Router {
	const innerRouter = Express.Router()
	const context: ExpressionVariablesRestContext = {
		...deps,
		logger: logger.child({ source: 'variables/v1/expression' }),
	}

	for (const endpointSpec of expressionVariableEndpointSpecs) {
		mountRestEndpoint(innerRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(EXPRESSION_VARIABLES_API_BASE_PATH, innerRouter)

	return router
}

export function registerExpressionVariablePaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of expressionVariableEndpointSpecs) {
		registerRestEndpoint(registry, EXPRESSION_VARIABLES_API_BASE_PATH, endpointSpec.contract)
	}
}

// ---- Helpers ----

function etagOf(model: ExpressionVariableModel): string {
	return computeEtag(stripExpressionVariableIds(model))
}

function getOrThrow(ctx: ExpressionVariablesRestContext, controlId: string): ControlExpressionVariable {
	const control = validateExpressionVariableControlId(controlId) ? ctx.controls.getControl(controlId) : undefined
	if (!control || control.type !== 'expression-variable') throw RestApiError.notFound('Expression variable not found')
	return control as ControlExpressionVariable
}

function buildResponse(
	ctx: ExpressionVariablesRestContext,
	controlId: string,
	warnings: ControlModelWarning[] = []
): { body: { data: ExpressionVariableResponse }; etag: string } {
	const control = getOrThrow(ctx, controlId)
	const model = control.toJSON(true)
	return {
		body: successResponse({
			controlId,
			model: model as unknown as ExpressionVariableResponse['model'],
			isActive: control.toClientJSON().isActive,
			value: currentValue(ctx, control),
			warnings,
		}),
		etag: etagOf(model),
	}
}

/** The current value, only for the variable that is active under its name */
function currentValue(ctx: ExpressionVariablesRestContext, control: ControlExpressionVariable): unknown {
	const info = control.toClientJSON()
	return info.isActive && info.variableName ? ctx.values.getVariableValue('expression', info.variableName) : undefined
}

/** Parse the body's entities, expanding the expression shorthand */
function normalizeInput(input: z.infer<typeof ExpressionVariableInputSchema>): Partial<ExpressionVariableModel> {
	if (input.expression !== undefined && input.entity !== undefined) {
		throw RestApiError.badRequest('Give either expression or entity, not both')
	}

	let entity: SomeEntityModel | null | undefined
	if (input.expression !== undefined) {
		entity = {
			id: nanoid(),
			type: EntityModelType.Feedback,
			connectionId: 'internal',
			definitionId: 'expression_value',
			options: { expression: { isExpression: false, value: input.expression } },
			upgradeIndex: undefined,
		}
	} else if (input.entity) {
		entity = normalizeEntities([input.entity], 'entity')[0]
	} else {
		entity = input.entity // null or undefined
	}

	return {
		...(input.options ? { options: input.options as ExpressionVariableModel['options'] } : {}),
		...(entity !== undefined ? { entity } : {}),
		...(input.localVariables ? { localVariables: normalizeEntities(input.localVariables, 'localVariables') } : {}),
	}
}

/** Complete and validate, including the name rules Companion leaves to the web UI */
function prepareOrThrow(
	ctx: ExpressionVariablesRestContext,
	input: Partial<ExpressionVariableModel>,
	query: z.infer<typeof WriteQuerySchema>,
	ownControlId: string | null
): { model: ExpressionVariableModel; warnings: ControlModelWarning[] } {
	const prepared = prepareExpressionVariableModel(input, ctx.definitions, {
		allowMissingDefinitions: query.allowMissingDefinitions === 'true',
	})

	const name = prepared.model.options.variableName
	if (!name || !isLabelValid(name)) {
		prepared.errors.unshift({
			path: 'options.variableName',
			code: 'invalid_value',
			message: 'A name is required: letters, digits, underscores and dashes, and not a reserved word',
		})
	}

	if (prepared.errors.length > 0) {
		throw RestApiError.unprocessable('Expression variable model is not valid', {
			errors: prepared.errors,
			warnings: prepared.warnings,
		})
	}

	const clash = ctx.controls
		.getAllExpressionVariables()
		.find((other) => other.controlId !== ownControlId && other.options.variableName === name)
	if (clash) throw RestApiError.conflict(`Expression variable "${name}" already exists (${clash.controlId})`)

	return { model: prepared.model, warnings: prepared.warnings }
}

function writeOrThrow(ctx: ExpressionVariablesRestContext, controlId: string, model: ExpressionVariableModel): void {
	if (!ctx.controls.importExpressionVariable(controlId, model)) throw new Error('Failed to write expression variable')
}

// ---- Endpoints ----

const expressionVariableEndpointSpecs: RestEndpointSpec<ExpressionVariablesRestContext>[] = [
	defineExpressionVariableEndpointSpec(
		{
			method: 'get',
			path: '/',
			scopes: ['read'],
			tags: EXPRESSION_VARIABLES_API_TAGS,
			summary: 'List expression variables',
			description: 'Returns a summary of every expression variable, in list order.',
			response: {
				status: 200,
				description: 'List of expression variables',
				schema: createCollectionSchema(SummaryResponseSchema),
			},
			examples: { response: collectionResponse([SummaryExample], { total: 1, limit: 1, offset: 0 }) },
			errorResponses,
		},
		(ctx) => {
			return () => {
				const items = ctx.controls
					.getAllExpressionVariables()
					.map((control) => {
						const info = control.toClientJSON()
						return {
							controlId: control.controlId,
							variableName: info.variableName,
							description: info.description,
							isActive: info.isActive,
							sortOrder: info.sortOrder,
							collectionId: info.collectionId ?? null,
							value: currentValue(ctx, control),
						}
					})
					.sort((a, b) => a.sortOrder - b.sortOrder)

				return { body: collectionResponse(items, { total: items.length, limit: items.length, offset: 0 }) }
			}
		}
	),

	defineExpressionVariableEndpointSpec(
		{
			method: 'get',
			path: '/:controlId',
			scopes: ['read'],
			tags: EXPRESSION_VARIABLES_API_TAGS,
			summary: 'Get an expression variable',
			description: 'Returns an expression variable with its full model. The ETag header identifies this version.',
			request: { params: controlIdParam },
			response: {
				status: 200,
				description: 'The expression variable',
				schema: createSuccessSchema(ExpressionVariableResponseSchema),
			},
			examples: { response: successResponse(ResponseExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				const { body, etag } = buildResponse(ctx, params.controlId)
				return { body, headers: { ETag: etag } }
			}
		}
	),

	defineExpressionVariableEndpointSpec(
		{
			method: 'post',
			path: '/',
			scopes: ['write'],
			tags: EXPRESSION_VARIABLES_API_TAGS,
			summary: 'Create an expression variable',
			description:
				'Create an expression variable. options.variableName is required and must be unique. Give expression for a plain expression, or entity for any value feedback.',
			request: { query: WriteQuerySchema, body: ExpressionVariableInputSchema },
			response: {
				status: 201,
				description: 'The created expression variable',
				schema: createSuccessSchema(ExpressionVariableResponseSchema),
			},
			examples: {
				body: {
					options: { variableName: 'dit_route_label', description: 'Label for the DIT route button' },
					expression: "concat('SRC ', $(kumo:dest_1_source))",
				},
				response: successResponse(ResponseExample),
			},
			extraResponses: { 409: extraWriteResponses[409], 422: extraWriteResponses[422] },
			errorResponses,
		},
		(ctx) => {
			return ({ query, body }) => {
				const input = normalizeInput(body)
				if (input.options?.sortOrder === undefined) {
					const maxRank = Math.max(-1, ...ctx.controls.getAllExpressionVariables().map((c) => c.options.sortOrder))
					input.options = { ...(input.options as ExpressionVariableModel['options']), sortOrder: maxRank + 1 }
				}
				const { model, warnings } = prepareOrThrow(ctx, input, query, null)

				if (query.dryRun === 'true') {
					// Nothing is created, so 200 rather than 201
					return {
						status: 200,
						body: successResponse({
							controlId: null,
							model: model as unknown as ExpressionVariableResponse['model'],
							isActive: true,
							warnings,
						}),
						headers: { ETag: etagOf(model) },
					}
				}

				const controlId = CreateExpressionVariableControlId(nanoid())
				writeOrThrow(ctx, controlId, model)
				ctx.logger.info(`Created expression variable ${controlId} "${model.options.variableName}"`)

				const { body: responseBody, etag } = buildResponse(ctx, controlId, warnings)
				return {
					status: 201,
					body: responseBody,
					headers: { ETag: etag },
					location: `${REST_API_BASE_PATH}${EXPRESSION_VARIABLES_API_BASE_PATH}/${controlId}`,
				}
			}
		}
	),

	...(['put', 'patch'] as const).map((method) =>
		defineExpressionVariableEndpointSpec(
			{
				method,
				path: '/:controlId',
				scopes: ['write'],
				tags: EXPRESSION_VARIABLES_API_TAGS,
				summary: method === 'put' ? 'Replace an expression variable' : 'Update an expression variable',
				description:
					method === 'put'
						? 'Replace an expression variable with a whole model, keeping its id. Send If-Match to only replace a version you have seen.'
						: 'Partially update an expression variable: options is merged; entity (or expression) and localVariables replace what is there. Send If-Match to only update a version you have seen.',
				request: { params: controlIdParam, query: WriteQuerySchema, body: ExpressionVariableInputSchema },
				response: {
					status: 200,
					description: 'The written expression variable',
					schema: createSuccessSchema(ExpressionVariableResponseSchema),
				},
				examples: { response: successResponse(ResponseExample) },
				extraResponses: extraWriteResponses,
				errorResponses,
			},
			(ctx) => {
				return ({ params, query, body, headers }) => {
					const current = getOrThrow(ctx, params.controlId).toJSON(true)
					checkIfMatch(headers, etagOf(current))

					const given = normalizeInput(body)
					const input: Partial<ExpressionVariableModel> =
						method === 'put'
							? {
									...given,
									options: {
										sortOrder: current.options.sortOrder,
										...given.options,
									} as ExpressionVariableModel['options'],
								}
							: { ...current, ...given, options: { ...current.options, ...given.options } }
					const { model, warnings } = prepareOrThrow(ctx, input, query, params.controlId)

					if (query.dryRun === 'true') {
						return {
							body: successResponse({
								controlId: params.controlId,
								model: model as unknown as ExpressionVariableResponse['model'],
								isActive: true,
								warnings,
							}),
							headers: { ETag: etagOf(model) },
						}
					}

					ctx.controls.deleteControl(params.controlId)
					writeOrThrow(ctx, params.controlId, model)
					ctx.logger.info(`Wrote expression variable ${params.controlId}`)

					const { body: responseBody, etag } = buildResponse(ctx, params.controlId, warnings)
					return { body: responseBody, headers: { ETag: etag } }
				}
			}
		)
	),

	defineExpressionVariableEndpointSpec(
		{
			method: 'delete',
			path: '/:controlId',
			scopes: ['write'],
			tags: EXPRESSION_VARIABLES_API_TAGS,
			summary: 'Delete an expression variable',
			description: 'Send If-Match to only delete a version you have seen.',
			request: { params: controlIdParam },
			response: { status: 204, description: 'Deleted' },
			extraResponses: { 412: extraWriteResponses[412] },
			errorResponses,
		},
		(ctx) => {
			return ({ params, headers }) => {
				checkIfMatch(headers, etagOf(getOrThrow(ctx, params.controlId).toJSON(true)))

				ctx.controls.deleteControl(params.controlId)
				ctx.logger.info(`Deleted expression variable ${params.controlId}`)

				return { status: 204 }
			}
		}
	),
]
