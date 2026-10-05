import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import z from 'zod'
import type { ClientEntityDefinition } from '@companion-app/shared/Model/EntityDefinitionModel.js'
import { EntityModelType, FeedbackEntitySubType } from '@companion-app/shared/Model/EntityModel.js'
import type { Logger } from '../Log/Controller.js'
import { RestApiError } from '../Service/RestApi/errors.js'
import {
	collectionResponse,
	createCollectionSchema,
	createSuccessSchema,
	errorResponses,
	successResponse,
} from '../Service/RestApi/schemas/common.js'
import {
	createRestEndpointSpecFactory,
	mountRestEndpoint,
	registerRestEndpoint,
	type RestEndpointSpec,
} from '../Service/RestApi/typedRoute.js'
import type { InstanceDefinitions } from './Definitions.js'
import { ENTITY_OPTION_ISSUE_CODES, validateEntityOptions } from './EntityOptionsValidator.js'

export const DEFINITIONS_API_BASE_PATH = '/definitions/v1'
const DEFINITIONS_API_TAGS = ['Definitions']

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** The members of InstanceDefinitions this resource reads */
export type DefinitionsSource = Pick<InstanceDefinitions, 'getAllEntityDefinitions' | 'getEntityDefinition'>

type DefinitionsRestContext = {
	logger: Logger
	definitions: DefinitionsSource
}

const defineDefinitionsEndpointSpec = createRestEndpointSpecFactory<DefinitionsRestContext>()

/** Schema for an option field of an action or feedback */
const OptionFieldResponseSchema = z
	.object({
		id: z.string().describe('Option id, used as the key in an options object.').meta({ example: 'input' }),
		type: z
			.string()
			.describe(
				'Field type, e.g. textinput, number, checkbox, dropdown, multidropdown, colorpicker, expression, custom-variable, static-text, or an internal:* type for built-in actions. Additional properties depend on the type and match the module API input field definitions.'
			)
			.meta({ example: 'dropdown' }),
		label: z.string().describe('Display label for the option.').meta({ example: 'Input' }),
		tooltip: z.string().optional().describe('Short help text for the option.'),
		description: z.string().optional().describe('Longer help text for the option.'),
		default: z.unknown().optional().describe('Default value used when the option is not set.'),
		disableAutoExpression: z.boolean().optional().describe('If true, the option cannot be set to an expression.'),
	})
	.catchall(z.unknown())

const DefinitionBaseResponseSchema = z.object({
	connectionId: z
		.string()
		.describe('Id of the connection providing the definition, or "internal" for built-in actions and feedbacks.')
		.meta({ example: 'nPi5lhVjy4hSOYsPz_YPj' }),
	definitionId: z.string().describe('Definition id, unique within the connection.').meta({ example: 'route' }),
	label: z.string().describe('Display label.').meta({ example: 'Route input to output' }),
	description: z.string().nullable().describe('Longer description, or null.'),
	sortKey: z.string().nullable().describe('Key used to order definitions in the UI, or null.'),
	optionsSupportExpressions: z
		.boolean()
		.describe("Whether option values may be expressions (subject to each field's disableAutoExpression)."),
	hasLearn: z.boolean().describe('Whether the definition supports learning its option values from the device.'),
	options: z.array(OptionFieldResponseSchema).describe('Option fields, in display order.'),
})

const ActionDefinitionResponseSchema = DefinitionBaseResponseSchema.extend({
	hasResult: z.boolean().describe('Whether the action returns a result that can be stored in a variable.'),
})

const FeedbackDefinitionResponseSchema = DefinitionBaseResponseSchema.extend({
	feedbackType: z
		.enum(FeedbackEntitySubType)
		.nullable()
		.describe('Kind of feedback: boolean, advanced, value or style-override.'),
	showInvert: z.boolean().describe('Whether the feedback can be inverted.'),
})

const ValidateBodySchema = z
	.object({
		options: z
			.record(z.string(), z.unknown())
			.describe(
				'Options to validate, keyed by option id, in stored form: { isExpression: false, value } or { isExpression: true, value: "<expression>" }. Omitted options are not errors.'
			),
	})
	.strict()

const ValidationResultResponseSchema = z.object({
	valid: z.boolean().describe('True if there are no errors. Warnings do not affect validity.'),
	errors: z
		.array(
			z.object({
				optionId: z.string(),
				code: z.enum(ENTITY_OPTION_ISSUE_CODES),
				message: z.string(),
			})
		)
		.describe('Problems that would make Companion reject or misinterpret the options.'),
	warnings: z
		.array(z.object({ optionId: z.string(), message: z.string() }))
		.describe('Values that can only be fully checked at run time.'),
})

const ListQuerySchema = z.object({
	connectionId: z.string().optional().describe('Only return definitions from this connection.'),
	q: z.string().optional().describe('Case-insensitive search across definition id, label and description.'),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.default(DEFAULT_LIMIT)
		.describe(`Maximum number of definitions to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
	offset: z.coerce.number().int().min(0).default(0).describe('Number of definitions to skip.'),
})

const DefinitionParamsSchema = z.object({
	connectionId: z.string().describe('Connection id, or "internal".').meta({ example: 'internal' }),
	definitionId: z.string().describe('Definition id.').meta({ example: 'set_page' }),
})

const BaseDefinitionExample = {
	connectionId: 'nPi5lhVjy4hSOYsPz_YPj',
	definitionId: 'route',
	label: 'Route input to output',
	description: null,
	sortKey: null,
	optionsSupportExpressions: true,
	hasLearn: false,
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
}

const ActionDefinitionExample: z.infer<typeof ActionDefinitionResponseSchema> = {
	...BaseDefinitionExample,
	hasResult: false,
}

const FeedbackDefinitionExample: z.infer<typeof FeedbackDefinitionResponseSchema> = {
	...BaseDefinitionExample,
	definitionId: 'routed',
	label: 'Input is routed to output',
	feedbackType: FeedbackEntitySubType.Boolean,
	showInvert: true,
}

/**
 * Create the definitions router for /api/v2/definitions/v1
 */
export function createDefinitionsRestApiRouter(logger: Logger, definitions: DefinitionsSource): Express.Router {
	const definitionsRouter = Express.Router()
	const context: DefinitionsRestContext = { logger: logger.child({ source: 'definitions/v1' }), definitions }

	for (const endpointSpec of definitionsEndpointSpecs) {
		mountRestEndpoint(definitionsRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(DEFINITIONS_API_BASE_PATH, definitionsRouter)

	return router
}

export function registerDefinitionsPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of definitionsEndpointSpecs) {
		registerRestEndpoint(registry, DEFINITIONS_API_BASE_PATH, endpointSpec.contract)
	}
}

function toActionResponse(connectionId: string, definitionId: string, definition: ClientEntityDefinition) {
	return {
		...toBaseResponse(connectionId, definitionId, definition),
		hasResult: !!definition.actionHasResult,
	}
}

function toFeedbackResponse(connectionId: string, definitionId: string, definition: ClientEntityDefinition) {
	return {
		...toBaseResponse(connectionId, definitionId, definition),
		feedbackType: definition.feedbackType,
		showInvert: definition.showInvert,
	}
}

function toBaseResponse(connectionId: string, definitionId: string, definition: ClientEntityDefinition) {
	return {
		connectionId,
		definitionId,
		label: definition.label,
		description: definition.description ?? null,
		sortKey: definition.sortKey,
		optionsSupportExpressions: definition.optionsSupportExpressions,
		hasLearn: definition.hasLearn,
		// Field interfaces have no index signature; the response schema parses and passes them through
		options: definition.options as z.infer<typeof OptionFieldResponseSchema>[],
	}
}

/**
 * Flatten, filter and order the definitions of one type. Ordered by connection id, then sort key,
 * then label, so pages are stable between requests.
 */
function listDefinitions(
	definitions: DefinitionsSource,
	entityType: EntityModelType,
	query: z.infer<typeof ListQuerySchema>
): { connectionId: string; definitionId: string; definition: ClientEntityDefinition }[] {
	const all = definitions.getAllEntityDefinitions(entityType)
	const needle = query.q?.toLowerCase()

	const items: { connectionId: string; definitionId: string; definition: ClientEntityDefinition }[] = []
	for (const [connectionId, connectionDefinitions] of Object.entries(all)) {
		if (query.connectionId !== undefined && connectionId !== query.connectionId) continue

		for (const [definitionId, definition] of Object.entries(connectionDefinitions)) {
			if (
				needle &&
				!definitionId.toLowerCase().includes(needle) &&
				!definition.label.toLowerCase().includes(needle) &&
				!definition.description?.toLowerCase().includes(needle)
			) {
				continue
			}
			items.push({ connectionId, definitionId, definition })
		}
	}

	return items.sort(
		(a, b) =>
			compareStrings(a.connectionId, b.connectionId) ||
			compareStrings(a.definition.sortKey ?? '', b.definition.sortKey ?? '') ||
			compareStrings(a.definition.label, b.definition.label) ||
			compareStrings(a.definitionId, b.definitionId)
	)
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function getDefinitionOrThrow(
	definitions: DefinitionsSource,
	entityType: EntityModelType,
	connectionId: string,
	definitionId: string
): ClientEntityDefinition {
	const definition = definitions.getEntityDefinition(entityType, connectionId, definitionId)
	if (!definition)
		throw RestApiError.notFound(`${entityType === EntityModelType.Action ? 'Action' : 'Feedback'} definition not found`)
	return definition
}

/** Build the list, get and validate endpoints for one entity type */
function createEntityTypeEndpointSpecs<TResponse extends z.ZodType>(
	entityType: EntityModelType,
	pathSegment: string,
	noun: string,
	responseSchema: TResponse,
	example: z.infer<TResponse>,
	toResponse: (connectionId: string, definitionId: string, definition: ClientEntityDefinition) => z.infer<TResponse>
): RestEndpointSpec<DefinitionsRestContext>[] {
	return [
		defineDefinitionsEndpointSpec(
			{
				method: 'get',
				path: `/${pathSegment}`,
				scopes: ['read'],
				tags: DEFINITIONS_API_TAGS,
				summary: `List ${noun} definitions`,
				description: `Returns the ${noun} definitions of all running connections, including built-in ones under the "internal" connection. Definitions only exist while a connection is running.`,
				request: { query: ListQuerySchema },
				response: {
					status: 200,
					description: `List of ${noun} definitions`,
					schema: createCollectionSchema(responseSchema),
				},
				examples: {
					response: collectionResponse([example], { total: 1, limit: DEFAULT_LIMIT, offset: 0 }),
				},
				errorResponses,
			},
			({ definitions }) => {
				return ({ query }) => {
					const items = listDefinitions(definitions, entityType, query)
					const page = items.slice(query.offset, query.offset + query.limit)

					return {
						body: collectionResponse(
							page.map((item) => toResponse(item.connectionId, item.definitionId, item.definition)),
							{ total: items.length, limit: query.limit, offset: query.offset }
						),
					}
				}
			}
		),

		defineDefinitionsEndpointSpec(
			{
				method: 'get',
				path: `/${pathSegment}/:connectionId/:definitionId`,
				scopes: ['read'],
				tags: DEFINITIONS_API_TAGS,
				summary: `Get ${noun} definition`,
				description: `Returns a single ${noun} definition with its option fields.`,
				request: { params: DefinitionParamsSchema },
				response: {
					status: 200,
					description: `The ${noun} definition`,
					schema: createSuccessSchema(responseSchema),
				},
				examples: { response: successResponse(example) },
				errorResponses,
			},
			({ definitions }) => {
				return ({ params }) => {
					const definition = getDefinitionOrThrow(definitions, entityType, params.connectionId, params.definitionId)
					return { body: successResponse(toResponse(params.connectionId, params.definitionId, definition)) }
				}
			}
		),

		defineDefinitionsEndpointSpec(
			{
				method: 'post',
				path: `/${pathSegment}/:connectionId/:definitionId/validate`,
				scopes: ['read'],
				tags: DEFINITIONS_API_TAGS,
				summary: `Validate ${noun} options`,
				description: `Check an options object against the ${noun} definition without changing anything. Always returns 200 with the validation result; 404 if the definition does not exist.`,
				request: { params: DefinitionParamsSchema, body: ValidateBodySchema },
				response: {
					status: 200,
					description: 'Validation result',
					schema: createSuccessSchema(ValidationResultResponseSchema),
				},
				examples: {
					body: { options: { input: { isExpression: false, value: 7 } } },
					response: successResponse({
						valid: false,
						errors: [
							{ optionId: 'input', code: 'invalid_value' as const, message: 'Value is not in the list of choices' },
						],
						warnings: [],
					}),
				},
				errorResponses,
			},
			({ definitions }) => {
				return ({ params, body }) => {
					const definition = getDefinitionOrThrow(definitions, entityType, params.connectionId, params.definitionId)
					return { body: successResponse(validateEntityOptions(definition, body.options)) }
				}
			}
		),
	]
}

const definitionsEndpointSpecs: RestEndpointSpec<DefinitionsRestContext>[] = [
	...createEntityTypeEndpointSpecs(
		EntityModelType.Action,
		'actions',
		'action',
		ActionDefinitionResponseSchema,
		ActionDefinitionExample,
		toActionResponse
	),
	...createEntityTypeEndpointSpecs(
		EntityModelType.Feedback,
		'feedbacks',
		'feedback',
		FeedbackDefinitionResponseSchema,
		FeedbackDefinitionExample,
		toFeedbackResponse
	),
]
