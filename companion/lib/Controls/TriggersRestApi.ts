import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import { nanoid } from 'nanoid'
import z from 'zod'
import { CreateTriggerControlId } from '@companion-app/shared/ControlId.js'
import type { EventDefinition } from '@companion-app/shared/Model/Common.js'
import type { TriggerCollectionData, TriggerModel } from '@companion-app/shared/Model/TriggerModel.js'
import type { Logger } from '../Log/Controller.js'
import { createCollectionsResource } from '../Resources/CollectionsRestApi.js'
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
import type { ControlsController } from './Controller.js'
import {
	prepareTriggerModel,
	stripTriggerIds,
	type ControlModelValidatorDeps,
	type ControlModelWarning,
} from './ControlModelValidator.js'
import { EntitySchema, normalizeEntities } from './ControlsRestApi.js'
import type { ControlTrigger } from './ControlTypes/Triggers/Trigger.js'
import { TriggerExecutionSource } from './ControlTypes/Triggers/TriggerExecutionSource.js'
import { validateTriggerControlId } from './Util.js'

export const TRIGGERS_API_BASE_PATH = '/triggers/v1'

/** /api/v2/triggers/v1/collections; mount before the trigger routes so "collections" is not taken as an id */
export const triggerCollectionsResource = createCollectionsResource<TriggerCollectionData>({
	basePath: `${TRIGGERS_API_BASE_PATH}/collections`,
	tags: ['Triggers'],
	noun: 'trigger',
	supportsEnabled: true,
	createMetaData: (enabled) => ({ enabled }),
})
const TRIGGERS_API_TAGS = ['Triggers']

export interface TriggersApiDeps {
	controls: Pick<ControlsController, 'getControl' | 'getAllTriggers' | 'importTrigger' | 'deleteControl'>
	definitions: ControlModelValidatorDeps
	eventDefinitions: Readonly<Record<string, EventDefinition>>
	collections: { doesCollectionIdExist(collectionId: string | null | undefined): boolean }
}

type TriggersRestContext = TriggersApiDeps & { logger: Logger }

const defineTriggerEndpointSpec = createRestEndpointSpecFactory<TriggersRestContext>()

// ---- Request schemas ----

const TriggerOptionsSchema = z
	.object({
		name: z.string().optional(),
		enabled: z.boolean().optional().describe('Whether the trigger runs. New triggers default to disabled.'),
		sortOrder: z.number().optional().describe('Position in the trigger list. Defaults to the end.'),
		collectionId: z.string().optional().describe('Collection to group the trigger in.'),
		notes: z.string().optional(),
	})
	.strict()

const EventSchema = z
	.object({
		id: z.string().optional().describe('Generated if omitted.'),
		type: z
			.string()
			.describe(
				'Event type, e.g. interval, timeofday, startup, button_press, condition_true, condition_false, variable_changed.'
			),
		enabled: z.boolean().optional().describe('Defaults to true.'),
		headline: z.string().optional(),
		options: z
			.record(z.string(), z.unknown())
			.default({})
			.describe('Plain option values (events do not use the expression form). Omitted options use their defaults.'),
	})
	.strict()

const TriggerModelInputSchema = z
	.object({
		type: z.literal('trigger').optional(),
		options: TriggerOptionsSchema.optional(),
		events: z.array(EventSchema).optional().describe('What fires the trigger.'),
		condition: z
			.array(EntitySchema)
			.optional()
			.describe('Boolean feedbacks that must all be true for the actions to run.'),
		actions: z.array(EntitySchema).optional().describe('Actions to run.'),
		localVariables: z.array(EntitySchema).optional(),
	})
	.strict()

const TriggerPatchBodySchema = z
	.object({
		options: TriggerOptionsSchema.optional().describe('Merged into the current options.'),
		events: TriggerModelInputSchema.shape.events.describe('Replaces all events.'),
		condition: TriggerModelInputSchema.shape.condition.describe('Replaces the whole condition.'),
		actions: TriggerModelInputSchema.shape.actions.describe('Replaces all actions.'),
		localVariables: TriggerModelInputSchema.shape.localVariables.describe('Replaces all local variables.'),
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
	controlId: z.string().describe('Trigger id.').meta({ example: 'trigger:Xk3pQ9wL0aZ5' }),
})

// ---- Response schemas ----

const TriggerSummaryExample = {
	controlId: 'trigger:Xk3pQ9wL0aZ5',
	name: 'DIT overlay prompt submitted',
	enabled: true,
	sortOrder: 0,
	collectionId: null,
	description: 'On condition becoming true',
	lastExecuted: null,
}

const TriggerSummaryResponseSchema = z
	.object({
		controlId: z.string(),
		name: z.string(),
		enabled: z.boolean(),
		sortOrder: z.number(),
		collectionId: z.string().nullable(),
		description: z.string().describe('Human-readable summary of the enabled events.'),
		lastExecuted: z.number().nullable().describe('When the trigger last ran (ms since epoch), or null.'),
	})
	.meta({ example: TriggerSummaryExample })

const TriggerResponseExample = {
	controlId: TriggerSummaryExample.controlId,
	model: {
		type: 'trigger' as const,
		options: { name: TriggerSummaryExample.name, enabled: true, sortOrder: 0, notes: '' },
		events: [{ id: 'ev1', type: 'condition_true', enabled: true, options: {} }],
		condition: [],
		actions: [],
		localVariables: [],
	},
	warnings: [],
}

const TriggerResponseSchema = z
	.object({
		controlId: z.string().nullable().describe('Trigger id; null in a dry run that would create a trigger.'),
		model: z
			.object({ type: z.literal('trigger') })
			.catchall(z.unknown())
			.describe('The trigger model as Companion stores it. Writable as-is with PUT.'),
		warnings: z.array(z.object({ path: z.string(), message: z.string() })),
	})
	.meta({ example: TriggerResponseExample })

type TriggerResponse = z.infer<typeof TriggerResponseSchema>

const extraWriteResponses = {
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
 * Create the triggers router for /api/v2/triggers/v1
 */
export function createTriggersRestApiRouter(logger: Logger, deps: TriggersApiDeps): Express.Router {
	const triggersRouter = Express.Router()
	const context: TriggersRestContext = { ...deps, logger: logger.child({ source: 'triggers/v1' }) }

	for (const endpointSpec of triggerEndpointSpecs) {
		mountRestEndpoint(triggersRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(TRIGGERS_API_BASE_PATH, triggersRouter)

	return router
}

export function registerTriggerPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of triggerEndpointSpecs) {
		registerRestEndpoint(registry, TRIGGERS_API_BASE_PATH, endpointSpec.contract)
	}
}

// ---- Helpers ----

function triggerEtag(model: TriggerModel): string {
	return computeEtag(stripTriggerIds(model))
}

function getTriggerOrThrow(ctx: TriggersRestContext, controlId: string): ControlTrigger {
	const control = validateTriggerControlId(controlId) ? ctx.controls.getControl(controlId) : undefined
	if (!control || control.type !== 'trigger') throw RestApiError.notFound('Trigger not found')
	return control as ControlTrigger
}

function asResponseModel(model: TriggerModel): TriggerResponse['model'] {
	return model as unknown as TriggerResponse['model']
}

function buildTriggerResponse(
	ctx: TriggersRestContext,
	controlId: string,
	warnings: ControlModelWarning[] = []
): { body: { data: TriggerResponse }; etag: string } {
	const model = getTriggerOrThrow(ctx, controlId).toJSON(true)
	return {
		body: successResponse({ controlId, model: asResponseModel(model), warnings }),
		etag: triggerEtag(model),
	}
}

/** Parse the entity lists of a trigger body, giving entities ids */
function normalizeTriggerInput(input: z.infer<typeof TriggerPatchBodySchema>): Partial<TriggerModel> {
	return {
		...(input.options ? { options: input.options as TriggerModel['options'] } : {}),
		...(input.events ? { events: input.events as TriggerModel['events'] } : {}),
		...(input.condition ? { condition: normalizeEntities(input.condition, 'condition') } : {}),
		...(input.actions ? { actions: normalizeEntities(input.actions, 'actions') } : {}),
		...(input.localVariables ? { localVariables: normalizeEntities(input.localVariables, 'localVariables') } : {}),
	}
}

function prepareOrThrow(
	ctx: TriggersRestContext,
	input: Partial<TriggerModel>,
	query: z.infer<typeof WriteQuerySchema>
): { model: TriggerModel; warnings: ControlModelWarning[] } {
	const prepared = prepareTriggerModel({ ...input, type: 'trigger' }, ctx.definitions, ctx.eventDefinitions, {
		allowMissingDefinitions: query.allowMissingDefinitions === 'true',
	})
	if (!ctx.collections.doesCollectionIdExist(prepared.model.options.collectionId)) {
		prepared.errors.push({ path: 'options.collectionId', code: 'invalid_value', message: 'Collection not found' })
	}
	if (prepared.errors.length > 0) {
		throw RestApiError.unprocessable('Trigger model is not valid', {
			errors: prepared.errors,
			warnings: prepared.warnings,
		})
	}
	return { model: prepared.model, warnings: prepared.warnings }
}

/** Replace a trigger with a new model, keeping its id */
function replaceTrigger(ctx: TriggersRestContext, controlId: string, model: TriggerModel): void {
	ctx.controls.deleteControl(controlId)
	if (!ctx.controls.importTrigger(controlId, model)) throw new Error('Failed to write trigger')
}

// ---- Endpoints ----

const triggerEndpointSpecs: RestEndpointSpec<TriggersRestContext>[] = [
	defineTriggerEndpointSpec(
		{
			method: 'get',
			path: '/',
			scopes: ['read'],
			tags: TRIGGERS_API_TAGS,
			summary: 'List triggers',
			description: 'Returns a summary of every trigger, in list order.',
			response: {
				status: 200,
				description: 'List of triggers',
				schema: createCollectionSchema(TriggerSummaryResponseSchema),
			},
			examples: { response: collectionResponse([TriggerSummaryExample], { total: 1, limit: 1, offset: 0 }) },
			errorResponses,
		},
		(ctx) => {
			return () => {
				const items = ctx.controls
					.getAllTriggers()
					.map((trigger) => {
						const info = trigger.toTriggerJSON()
						return {
							controlId: trigger.controlId,
							name: info.name,
							enabled: info.enabled,
							sortOrder: info.sortOrder,
							collectionId: info.collectionId ?? null,
							description: info.description,
							lastExecuted: info.lastExecuted,
						}
					})
					.sort((a, b) => a.sortOrder - b.sortOrder)

				return { body: collectionResponse(items, { total: items.length, limit: items.length, offset: 0 }) }
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'get',
			path: '/:controlId',
			scopes: ['read'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Get a trigger',
			description: 'Returns a trigger with its full model. The ETag header identifies this version.',
			request: { params: controlIdParam },
			response: { status: 200, description: 'The trigger', schema: createSuccessSchema(TriggerResponseSchema) },
			examples: { response: successResponse(TriggerResponseExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				const { body, etag } = buildTriggerResponse(ctx, params.controlId)
				return { body, headers: { ETag: etag } }
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'post',
			path: '/',
			scopes: ['write'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Create a trigger',
			description:
				'Create a trigger from a model. Everything may be left out; new triggers are disabled unless options.enabled is true. Validated like controls: a 422 lists every problem with its path.',
			request: { query: WriteQuerySchema, body: TriggerModelInputSchema },
			response: {
				status: 201,
				description: 'The created trigger',
				schema: createSuccessSchema(TriggerResponseSchema),
			},
			examples: {
				body: {
					options: { name: 'DIT overlay prompt submitted', enabled: true },
					events: [{ type: 'condition_true' }],
				},
				response: successResponse(TriggerResponseExample),
			},
			extraResponses: { 422: extraWriteResponses[422] },
			errorResponses,
		},
		(ctx) => {
			return ({ query, body }) => {
				const input = normalizeTriggerInput(body)
				if (input.options?.sortOrder === undefined) {
					const maxRank = Math.max(-1, ...ctx.controls.getAllTriggers().map((t) => t.options.sortOrder))
					input.options = { ...(input.options as TriggerModel['options']), sortOrder: maxRank + 1 }
				}
				const { model, warnings } = prepareOrThrow(ctx, input, query)

				if (query.dryRun === 'true') {
					// Nothing is created, so 200 rather than 201
					return {
						status: 200,
						body: successResponse({ controlId: null, model: asResponseModel(model), warnings }),
						headers: { ETag: triggerEtag(model) },
					}
				}

				const controlId = CreateTriggerControlId(nanoid())
				if (!ctx.controls.importTrigger(controlId, model)) throw new Error('Failed to create trigger')
				ctx.logger.info(`Created trigger ${controlId} "${model.options.name}"`)

				const { body: responseBody, etag } = buildTriggerResponse(ctx, controlId, warnings)
				return {
					status: 201,
					body: responseBody,
					headers: { ETag: etag },
					location: `${REST_API_BASE_PATH}${TRIGGERS_API_BASE_PATH}/${controlId}`,
				}
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'put',
			path: '/:controlId',
			scopes: ['write'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Replace a trigger',
			description:
				'Replace a trigger with a whole model, keeping its id. Entity ids are regenerated. Send If-Match to only replace a version you have seen.',
			request: { params: controlIdParam, query: WriteQuerySchema, body: TriggerModelInputSchema },
			response: { status: 200, description: 'The written trigger', schema: createSuccessSchema(TriggerResponseSchema) },
			examples: { response: successResponse(TriggerResponseExample) },
			extraResponses: extraWriteResponses,
			errorResponses,
		},
		(ctx) => {
			return ({ params, query, body, headers }) => {
				const current = getTriggerOrThrow(ctx, params.controlId).toJSON(true)
				checkIfMatch(headers, triggerEtag(current))

				// A replaced trigger keeps its place in the list unless the body gives a new one
				const input = normalizeTriggerInput(body)
				if (input.options?.sortOrder === undefined) {
					input.options = { ...(input.options as TriggerModel['options']), sortOrder: current.options.sortOrder }
				}
				const { model, warnings } = prepareOrThrow(ctx, input, query)

				if (query.dryRun === 'true') {
					return {
						body: successResponse({ controlId: params.controlId, model: asResponseModel(model), warnings }),
						headers: { ETag: triggerEtag(model) },
					}
				}

				replaceTrigger(ctx, params.controlId, model)
				ctx.logger.info(`Replaced trigger ${params.controlId}`)

				const { body: responseBody, etag } = buildTriggerResponse(ctx, params.controlId, warnings)
				return { body: responseBody, headers: { ETag: etag } }
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'patch',
			path: '/:controlId',
			scopes: ['write'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Update a trigger',
			description:
				'Partially update a trigger: options is merged; events, condition, actions and localVariables each replace the whole list when given. Use { "options": { "enabled": false } } to disable it. Send If-Match to only update a version you have seen.',
			request: { params: controlIdParam, query: WriteQuerySchema, body: TriggerPatchBodySchema },
			response: { status: 200, description: 'The updated trigger', schema: createSuccessSchema(TriggerResponseSchema) },
			examples: { body: { options: { enabled: false } }, response: successResponse(TriggerResponseExample) },
			extraResponses: extraWriteResponses,
			errorResponses,
		},
		(ctx) => {
			return ({ params, query, body, headers }) => {
				const current = getTriggerOrThrow(ctx, params.controlId).toJSON(true)
				checkIfMatch(headers, triggerEtag(current))

				const given = normalizeTriggerInput(body)
				const { model, warnings } = prepareOrThrow(
					ctx,
					{ ...current, ...given, options: { ...current.options, ...given.options } },
					query
				)

				if (query.dryRun === 'true') {
					return {
						body: successResponse({ controlId: params.controlId, model: asResponseModel(model), warnings }),
						headers: { ETag: triggerEtag(model) },
					}
				}

				replaceTrigger(ctx, params.controlId, model)
				ctx.logger.info(`Updated trigger ${params.controlId}`)

				const { body: responseBody, etag } = buildTriggerResponse(ctx, params.controlId, warnings)
				return { body: responseBody, headers: { ETag: etag } }
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'delete',
			path: '/:controlId',
			scopes: ['write'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Delete a trigger',
			description: 'Send If-Match to only delete a version you have seen.',
			request: { params: controlIdParam },
			response: { status: 204, description: 'Trigger deleted' },
			extraResponses: { 412: extraWriteResponses[412] },
			errorResponses,
		},
		(ctx) => {
			return ({ params, headers }) => {
				const current = getTriggerOrThrow(ctx, params.controlId).toJSON(true)
				checkIfMatch(headers, triggerEtag(current))

				ctx.controls.deleteControl(params.controlId)
				ctx.logger.info(`Deleted trigger ${params.controlId}`)

				return { status: 204 }
			}
		}
	),

	defineTriggerEndpointSpec(
		{
			method: 'post',
			path: '/:controlId/test',
			scopes: ['execute'],
			tags: TRIGGERS_API_TAGS,
			summary: 'Test-fire a trigger',
			description:
				"Run the trigger's actions now, ignoring its events and condition, as the web UI's test button does.",
			request: { params: controlIdParam },
			response: { status: 204, description: 'Actions started' },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				getTriggerOrThrow(ctx, params.controlId).executeActions(Date.now(), TriggerExecutionSource.Test)
				return { status: 204 }
			}
		}
	),
]
