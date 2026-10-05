import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import type { JsonValue } from 'type-fest'
import z from 'zod'
import type { CustomVariableDefinition } from '@companion-app/shared/Model/CustomVariableModel.js'
import type { Logger } from '../Log/Controller.js'
import { createCollectionsResource } from '../Resources/CollectionsRestApi.js'
import { REST_API_BASE_PATH } from '../Service/RestApi/constants.js'
import { RestApiError } from '../Service/RestApi/errors.js'
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
import type { VariablesController } from './Controller.js'

export const VARIABLES_API_BASE_PATH = '/variables/v1'

/**
 * /api/v2/variables/v1/custom/collections; mount before the custom variable routes. Note that a custom
 * variable named "collections" is shadowed there; reach it through /values/custom/collections instead.
 */
export const customVariableCollectionsResource = createCollectionsResource<null>({
	basePath: `${VARIABLES_API_BASE_PATH}/custom/collections`,
	tags: ['Variables'],
	noun: 'custom variable',
	supportsEnabled: false,
	createMetaData: () => null,
})
const VARIABLES_API_TAGS = ['Variables']

/** The variable namespace custom variables live in, as in $(custom:name) */
const CUSTOM_NAMESPACE = 'custom'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** The members of VariablesController this resource uses */
export type VariablesApiController = {
	custom: Pick<
		VariablesController['custom'],
		| 'getDefinitions'
		| 'getValue'
		| 'createVariable'
		| 'deleteVariable'
		| 'setValue'
		| 'setVariableDefaultValue'
		| 'setVariableDescription'
		| 'setPersistence'
		| 'setOrder'
	> & { collections: Pick<VariablesController['custom']['collections'], 'doesCollectionIdExist'> }
	values: Pick<VariablesController['values'], 'getVariableValue'>
	definitions: Pick<VariablesController['definitions'], 'getAllVariableDefinitions'>
}

type VariablesRestContext = {
	logger: Logger
	variables: VariablesApiController
}

const defineVariablesEndpointSpec = createRestEndpointSpecFactory<VariablesRestContext>()

/** A JSON value in a request body */
// Not z.json(): it is recursive, which the OpenAPI generator cannot handle. Bodies are already parsed JSON.
const JsonValueSchema = z
	.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
	.describe('Any JSON value.') as unknown as z.ZodType<JsonValue>
/** A variable value in a response; typed loosely, as Companion's value type is wider than zod's JSON type */
const ValueResponseSchema = z.unknown()

const CustomVariableExample = {
	name: 'chord_dit_fired',
	description: 'Set when a DIT chord fired, so the key release does nothing',
	defaultValue: false,
	currentValue: false,
	persistCurrentValue: false,
	collectionId: null,
}

const CustomVariableResponseSchema = z
	.object({
		name: z.string().describe('Variable name, referenced as $(custom:<name>).'),
		description: z.string().describe('Description shown in the web UI.'),
		defaultValue: ValueResponseSchema.optional().describe(
			'Value the variable starts with when Companion starts. Omitted if unset.'
		),
		currentValue: ValueResponseSchema.optional().describe('Current value. Omitted if unset.'),
		persistCurrentValue: z
			.boolean()
			.describe('If true, the current value survives restarts: the default value follows the current value.'),
		collectionId: z.string().nullable().describe('Collection the variable is grouped in, or null.'),
	})
	.meta({ example: CustomVariableExample })

const CustomVariableCreateBodySchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(/^\w+$/, 'Name may only contain letters, digits and underscores')
			.describe('Variable name. Letters, digits and underscores only.'),
		defaultValue: JsonValueSchema.optional().describe('Starting value. Defaults to an empty string.'),
		description: z.string().optional().describe('Description shown in the web UI.'),
		persistCurrentValue: z.boolean().optional().describe('Keep the current value across restarts. Defaults to false.'),
		collectionId: z
			.string()
			.nullable()
			.optional()
			.describe('Collection to put the variable in; null or omitted for none.'),
	})
	.strict()

const CustomVariablePatchBodySchema = z
	.object({
		description: z.string().optional().describe('New description.'),
		defaultValue: JsonValueSchema.optional().describe(
			'New default value. null is stored as the value null. Rejected while persistCurrentValue is (or becomes) true, since the default then follows the current value.'
		),
		persistCurrentValue: z
			.boolean()
			.optional()
			.describe('Turning this on copies the current value into the default value.'),
		collectionId: z
			.string()
			.nullable()
			.optional()
			.describe('Move the variable to this collection (appended at the end); null for none.'),
	})
	.strict()

const CustomVariableValueResponseSchema = z.object({
	name: z.string(),
	value: ValueResponseSchema.optional().describe('Current value. Omitted if unset.'),
})

const CustomVariableValueBodySchema = z
	.object({
		value: JsonValueSchema.describe('New current value.'),
	})
	.strict()

const VariableValueResponseSchema = z
	.object({
		namespace: z
			.string()
			.describe('Variable namespace: a connection label, "internal" or "custom", as in $(<namespace>:<name>).'),
		name: z.string().describe('Variable name within the namespace.'),
		description: z.string().describe('Variable description.'),
		value: ValueResponseSchema.optional().describe('Current value. Omitted if unset.'),
	})
	.meta({
		example: { namespace: 'internal', name: 'time_hms', description: 'Time of day (HH:MM:SS)', value: '14:02:11' },
	})

const ValuesListQuerySchema = z.object({
	namespace: z.string().optional().describe('Only return variables in this namespace.'),
	q: z.string().optional().describe('Case-insensitive search across name and description.'),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.default(DEFAULT_LIMIT)
		.describe(`Maximum number of variables to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
	offset: z.coerce.number().int().min(0).default(0).describe('Number of variables to skip.'),
})

const customNameParam = z.object({
	name: z.string().describe('Custom variable name.').meta({ example: CustomVariableExample.name }),
})

const valueParams = z.object({
	namespace: z.string().describe('Variable namespace.').meta({ example: 'internal' }),
	name: z.string().describe('Variable name.').meta({ example: 'time_hms' }),
})

const conflictResponse = {
	409: { description: 'Conflict', content: { 'application/json': { schema: ErrorResponseSchema } } },
}

type CustomVariableResponse = z.infer<typeof CustomVariableResponseSchema>
type VariableValueResponse = z.infer<typeof VariableValueResponseSchema>

/**
 * Create the variables router for /api/v2/variables/v1
 */
export function createVariablesRestApiRouter(logger: Logger, variables: VariablesApiController): Express.Router {
	const variablesRouter = Express.Router()
	const context: VariablesRestContext = { logger: logger.child({ source: 'variables/v1' }), variables }

	for (const endpointSpec of variablesEndpointSpecs) {
		mountRestEndpoint(variablesRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(VARIABLES_API_BASE_PATH, variablesRouter)

	return router
}

export function registerVariablesPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of variablesEndpointSpecs) {
		registerRestEndpoint(registry, VARIABLES_API_BASE_PATH, endpointSpec.contract)
	}
}

function buildCustomVariableResponse(
	variables: VariablesApiController,
	name: string,
	definition: CustomVariableDefinition
): CustomVariableResponse {
	return {
		name,
		description: definition.description,
		defaultValue: definition.defaultValue,
		currentValue: variables.custom.getValue(name),
		persistCurrentValue: definition.persistCurrentValue,
		collectionId: definition.collectionId ?? null,
	}
}

/** Look up a key without falling through to the prototype (variable names are user input) */
function getOwn<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined
}

function getCustomVariableOrThrow(variables: VariablesApiController, name: string): CustomVariableDefinition {
	const definition = getOwn(variables.custom.getDefinitions(), name)
	if (!definition) throw RestApiError.notFound('Custom variable not found')
	return definition
}

/** Collections are checked up front, as Companion silently ignores a move to an unknown one */
function checkCollectionExists(variables: VariablesApiController, collectionId: string | null | undefined): void {
	if (collectionId && !variables.custom.collections.doesCollectionIdExist(collectionId)) {
		throw RestApiError.badRequest(`Collection "${collectionId}" not found`)
	}
}

/** Throw if one of the custom variable setters reported a failure */
function assertNoFailure(failure: string | null): void {
	if (failure) throw RestApiError.badRequest(failure)
}

/** Every known variable, with its value, ordered by namespace then name */
function listVariableValues(variables: VariablesApiController): VariableValueResponse[] {
	const items: VariableValueResponse[] = []

	for (const [namespace, definitions] of Object.entries(variables.definitions.getAllVariableDefinitions())) {
		for (const [name, definition] of Object.entries(definitions ?? {})) {
			items.push({
				namespace,
				name,
				description: definition.description,
				value: variables.values.getVariableValue(namespace, name),
			})
		}
	}

	for (const [name, definition] of Object.entries(variables.custom.getDefinitions())) {
		items.push({
			namespace: CUSTOM_NAMESPACE,
			name,
			description: definition.description,
			value: variables.custom.getValue(name),
		})
	}

	return items.sort((a, b) => compareStrings(a.namespace, b.namespace) || compareStrings(a.name, b.name))
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

const variablesEndpointSpecs: RestEndpointSpec<VariablesRestContext>[] = [
	defineVariablesEndpointSpec(
		{
			method: 'get',
			path: '/custom',
			scopes: ['read'],
			tags: VARIABLES_API_TAGS,
			summary: 'List custom variables',
			description: 'Returns every custom variable with its definition and current value, ordered by name.',
			response: {
				status: 200,
				description: 'List of custom variables',
				schema: createCollectionSchema(CustomVariableResponseSchema),
			},
			examples: { response: collectionResponse([CustomVariableExample], { total: 1, limit: 1, offset: 0 }) },
			errorResponses,
		},
		({ variables }) => {
			return () => {
				const items = Object.entries(variables.custom.getDefinitions())
					.sort(([a], [b]) => compareStrings(a, b))
					.map(([name, definition]) => buildCustomVariableResponse(variables, name, definition))

				return { body: collectionResponse(items, { total: items.length, limit: items.length, offset: 0 }) }
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'post',
			path: '/custom',
			scopes: ['write'],
			tags: VARIABLES_API_TAGS,
			summary: 'Create a custom variable',
			description: 'Create a custom variable. Its current value starts at the default value.',
			request: { body: CustomVariableCreateBodySchema },
			response: {
				status: 201,
				description: 'The created custom variable',
				schema: createSuccessSchema(CustomVariableResponseSchema),
			},
			examples: {
				body: { name: 'chord_dit_fired', defaultValue: false, description: CustomVariableExample.description },
				response: successResponse(CustomVariableExample),
			},
			extraResponses: conflictResponse,
			errorResponses,
		},
		({ logger, variables }) => {
			return ({ body }) => {
				if (getOwn(variables.custom.getDefinitions(), body.name)) {
					throw RestApiError.conflict(`Custom variable "${body.name}" already exists`)
				}
				checkCollectionExists(variables, body.collectionId)

				assertNoFailure(variables.custom.createVariable(body.name, body.defaultValue ?? ''))
				if (body.description !== undefined) {
					assertNoFailure(variables.custom.setVariableDescription(body.name, body.description))
				}
				if (body.persistCurrentValue) {
					assertNoFailure(variables.custom.setPersistence(body.name, true))
				}
				if (body.collectionId) variables.custom.setOrder(body.collectionId, body.name, -1)

				logger.info(`Created custom variable "${body.name}"`)

				return {
					status: 201,
					body: successResponse(
						buildCustomVariableResponse(variables, body.name, getCustomVariableOrThrow(variables, body.name))
					),
					location: `${REST_API_BASE_PATH}${VARIABLES_API_BASE_PATH}/custom/${encodeURIComponent(body.name)}`,
				}
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'get',
			path: '/custom/:name',
			scopes: ['read'],
			tags: VARIABLES_API_TAGS,
			summary: 'Get a custom variable',
			request: { params: customNameParam },
			response: {
				status: 200,
				description: 'The custom variable',
				schema: createSuccessSchema(CustomVariableResponseSchema),
			},
			examples: { response: successResponse(CustomVariableExample) },
			errorResponses,
		},
		({ variables }) => {
			return ({ params }) => {
				const definition = getCustomVariableOrThrow(variables, params.name)
				return { body: successResponse(buildCustomVariableResponse(variables, params.name, definition)) }
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'patch',
			path: '/custom/:name',
			scopes: ['write'],
			tags: VARIABLES_API_TAGS,
			summary: 'Update a custom variable',
			description:
				'Update the description, default value or persistence of a custom variable. Fields left out are unchanged. The current value is changed through the value endpoint.',
			request: { params: customNameParam, body: CustomVariablePatchBodySchema },
			response: {
				status: 200,
				description: 'The updated custom variable',
				schema: createSuccessSchema(CustomVariableResponseSchema),
			},
			examples: {
				body: { defaultValue: true },
				response: successResponse({ ...CustomVariableExample, defaultValue: true }),
			},
			extraResponses: conflictResponse,
			errorResponses,
		},
		({ logger, variables }) => {
			return ({ params, body }) => {
				const definition = getCustomVariableOrThrow(variables, params.name)

				checkCollectionExists(variables, body.collectionId)

				// The default value is locked while the current value is persisted, so check before changing anything
				const willPersist = body.persistCurrentValue ?? definition.persistCurrentValue
				if (body.defaultValue !== undefined && willPersist) {
					throw RestApiError.conflict(
						'Cannot set defaultValue while persistCurrentValue is true; the default follows the current value'
					)
				}

				// Turn persistence off before setting the default, as setting it is rejected while persisting
				if (body.persistCurrentValue === false) {
					assertNoFailure(variables.custom.setPersistence(params.name, false))
				}
				if (body.defaultValue !== undefined) {
					assertNoFailure(variables.custom.setVariableDefaultValue(params.name, body.defaultValue))
				}
				if (body.description !== undefined) {
					assertNoFailure(variables.custom.setVariableDescription(params.name, body.description))
				}
				if (body.persistCurrentValue === true) {
					assertNoFailure(variables.custom.setPersistence(params.name, true))
				}
				if (body.collectionId !== undefined && body.collectionId !== (definition.collectionId ?? null)) {
					variables.custom.setOrder(body.collectionId, params.name, -1)
				}

				logger.info(`Updated custom variable "${params.name}"`)

				return {
					body: successResponse(
						buildCustomVariableResponse(variables, params.name, getCustomVariableOrThrow(variables, params.name))
					),
				}
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'delete',
			path: '/custom/:name',
			scopes: ['write'],
			tags: VARIABLES_API_TAGS,
			summary: 'Delete a custom variable',
			description: 'Delete a custom variable. Buttons and triggers referencing it are not changed.',
			request: { params: customNameParam },
			response: { status: 204, description: 'Custom variable deleted' },
			errorResponses,
		},
		({ logger, variables }) => {
			return ({ params }) => {
				getCustomVariableOrThrow(variables, params.name)

				variables.custom.deleteVariable(params.name)
				logger.info(`Deleted custom variable "${params.name}"`)

				return { status: 204 }
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'get',
			path: '/custom/:name/value',
			scopes: ['read'],
			tags: VARIABLES_API_TAGS,
			summary: 'Get the value of a custom variable',
			request: { params: customNameParam },
			response: {
				status: 200,
				description: 'The current value',
				schema: createSuccessSchema(CustomVariableValueResponseSchema),
			},
			examples: { response: successResponse({ name: 'chord_dit_fired', value: false }) },
			errorResponses,
		},
		({ variables }) => {
			return ({ params }) => {
				getCustomVariableOrThrow(variables, params.name)
				return { body: successResponse({ name: params.name, value: variables.custom.getValue(params.name) }) }
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'put',
			path: '/custom/:name/value',
			scopes: ['execute'],
			tags: VARIABLES_API_TAGS,
			summary: 'Set the value of a custom variable',
			description:
				'Set the current value. This takes effect immediately, like an action: feedbacks and triggers watching the variable react to it.',
			request: { params: customNameParam, body: CustomVariableValueBodySchema },
			response: {
				status: 200,
				description: 'The new value',
				schema: createSuccessSchema(CustomVariableValueResponseSchema),
			},
			examples: {
				body: { value: true },
				response: successResponse({ name: 'chord_dit_fired', value: true }),
			},
			errorResponses,
		},
		({ variables }) => {
			return ({ params, body }) => {
				getCustomVariableOrThrow(variables, params.name)

				assertNoFailure(variables.custom.setValue(params.name, body.value))

				return { body: successResponse({ name: params.name, value: variables.custom.getValue(params.name) }) }
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'get',
			path: '/values',
			scopes: ['read'],
			tags: VARIABLES_API_TAGS,
			summary: 'List variables with their values',
			description:
				'Returns every defined variable (connection, internal and custom) with its description and current value, ordered by namespace then name.',
			request: { query: ValuesListQuerySchema },
			response: {
				status: 200,
				description: 'List of variables',
				schema: createCollectionSchema(VariableValueResponseSchema),
			},
			examples: {
				response: collectionResponse(
					[{ namespace: 'internal', name: 'time_hms', description: 'Time of day (HH:MM:SS)', value: '14:02:11' }],
					{ total: 1, limit: DEFAULT_LIMIT, offset: 0 }
				),
			},
			errorResponses,
		},
		({ variables }) => {
			return ({ query }) => {
				const needle = query.q?.toLowerCase()
				const items = listVariableValues(variables).filter(
					(item) =>
						(query.namespace === undefined || item.namespace === query.namespace) &&
						(!needle || item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle))
				)

				return {
					body: collectionResponse(items.slice(query.offset, query.offset + query.limit), {
						total: items.length,
						limit: query.limit,
						offset: query.offset,
					}),
				}
			}
		}
	),

	defineVariablesEndpointSpec(
		{
			method: 'get',
			path: '/values/:namespace/:name',
			scopes: ['read'],
			tags: VARIABLES_API_TAGS,
			summary: 'Get a variable with its value',
			request: { params: valueParams },
			response: {
				status: 200,
				description: 'The variable',
				schema: createSuccessSchema(VariableValueResponseSchema),
			},
			examples: {
				response: successResponse({
					namespace: 'internal',
					name: 'time_hms',
					description: 'Time of day (HH:MM:SS)',
					value: '14:02:11',
				}),
			},
			errorResponses,
		},
		({ variables }) => {
			return ({ params }) => {
				const definition =
					params.namespace === CUSTOM_NAMESPACE
						? getOwn(variables.custom.getDefinitions(), params.name)
						: getOwn(getOwn(variables.definitions.getAllVariableDefinitions(), params.namespace), params.name)
				if (!definition) throw RestApiError.notFound('Variable not found')

				return {
					body: successResponse({
						namespace: params.namespace,
						name: params.name,
						description: definition.description,
						value:
							params.namespace === CUSTOM_NAMESPACE
								? variables.custom.getValue(params.name)
								: variables.values.getVariableValue(params.namespace, params.name),
					}),
				}
			}
		}
	),
]
