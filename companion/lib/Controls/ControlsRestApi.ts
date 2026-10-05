import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import { nanoid } from 'nanoid'
import z from 'zod'
import type { SomeButtonModel } from '@companion-app/shared/Model/ButtonModel.js'
import { EntityModelType, type SomeEntityModel } from '@companion-app/shared/Model/EntityModel.js'
import type { DataUserConfig } from '../Data/UserConfig.js'
import type { Logger } from '../Log/Controller.js'
import type { IPageStore } from '../Page/Store.js'
import { REST_API_BASE_PATH } from '../Service/RestApi/constants.js'
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
	prepareControlModel,
	stripEntityIds,
	type ControlModelValidatorDeps,
	type ControlModelWarning,
} from './ControlModelValidator.js'
import { validateBankControlId } from './Util.js'

export const CONTROLS_API_BASE_PATH = '/controls/v1'
const CONTROLS_API_TAGS = ['Controls']

export type ControlsApiControls = Pick<
	ControlsController,
	'getControl' | 'importControl' | 'deleteControl' | 'pressControl' | 'rotateControl'
>

export interface ControlsApiDeps {
	controls: ControlsApiControls
	pageStore: Pick<IPageStore, 'getPageNumber' | 'getPageId' | 'getControlIdAt' | 'getLocationOfControlId'>
	definitions: ControlModelValidatorDeps
	userconfig: Pick<DataUserConfig, 'getKey'>
}

type ControlsRestContext = ControlsApiDeps & { logger: Logger }

const defineControlEndpointSpec = createRestEndpointSpecFactory<ControlsRestContext>()

// ---- Request schemas ----
// Children and style elements are typed loosely here (no recursive schemas: the OpenAPI generator cannot
// handle them). Their content is validated by prepareControlModel, which reports errors with a path.

const ExpressionOrValueSchema = z
	.object({ isExpression: z.boolean(), value: z.unknown() })
	.strict()
	.describe('A stored option value: { isExpression: false, value } or { isExpression: true, value: "<expression>" }.')

const EntitySchema = z
	.object({
		id: z.string().optional().describe('Ignored on write: entity ids are regenerated.'),
		type: z.enum(EntityModelType).describe('action or feedback.'),
		connectionId: z.string().min(1).describe('Connection id, or "internal".'),
		definitionId: z.string().min(1).describe('Definition id, from the definitions resource.'),
		options: z
			.record(z.string(), ExpressionOrValueSchema)
			.default({})
			.describe('Option values keyed by option id. Omitted options use their defaults.'),
		headline: z.string().optional(),
		disabled: z.boolean().optional(),
		upgradeIndex: z.number().int().optional().describe('Omit to mean "current".'),
		isInverted: ExpressionOrValueSchema.optional().describe('Feedbacks only: invert a boolean feedback.'),
		variableName: z.string().optional().describe('Local variables only: the variable name.'),
		styleOverrides: z
			.array(
				z
					.object({
						overrideId: z.string(),
						elementId: z.string(),
						elementProperty: z.string(),
						override: ExpressionOrValueSchema,
					})
					.strict()
			)
			.optional()
			.describe('Feedbacks only: style element properties this feedback overrides.'),
		storeResult: z.unknown().optional().describe('Actions only: where to store the action result.'),
		children: z
			.record(z.string(), z.array(z.unknown()))
			.optional()
			.describe('Child entities of internal logic entities, keyed by child group id. Same shape as this entity.'),
	})
	.strict()

const StepSchema = z
	.object({
		action_sets: z
			.record(z.string(), z.array(EntitySchema))
			.describe('Actions keyed by set: down, up, rotate_left, rotate_right, or a hold duration in ms.'),
		options: z
			.object({
				runWhileHeld: z.array(z.number()).default([]),
				name: z.string().optional(),
			})
			.strict()
			.default({ runWhileHeld: [] }),
	})
	.strict()

const StyleElementSchema = z
	.object({
		id: z.string().min(1).optional().describe('Element id; generated if omitted. Needed to target style overrides.'),
		type: z.string().describe('canvas, text, image, box, line, group, circle, composite, reference or gauge.'),
		name: z.string().optional(),
		usage: z.string().optional(),
	})
	.catchall(z.unknown())
	.describe('A style element. Properties left out take the defaults for its type.')

const LayeredButtonInputSchema = z
	.object({
		type: z.literal('button-layered'),
		options: z
			.object({
				stepProgression: z.enum(['auto', 'manual', 'expression']).optional(),
				stepExpression: z.string().optional(),
				rotaryActions: z.boolean().optional(),
				canModifyStyleInApis: z.boolean().optional(),
				notes: z.string().optional(),
			})
			.strict()
			.optional(),
		style: z
			.object({ layers: z.array(StyleElementSchema).min(1).describe('Layers, bottom first; the first is the canvas.') })
			.strict()
			.optional()
			.describe('Omit for the default button style.'),
		feedbacks: z.array(EntitySchema).optional(),
		steps: z.record(z.string(), StepSchema).optional().describe('Steps keyed by step id. Omit for one empty step.'),
		localVariables: z.array(EntitySchema).optional(),
	})
	.strict()

const ControlModelInputSchema = z.discriminatedUnion('type', [
	LayeredButtonInputSchema,
	z.object({ type: z.literal('pageup') }).strict(),
	z.object({ type: z.literal('pagedown') }).strict(),
	z.object({ type: z.literal('pagenum') }).strict(),
	z
		.object({
			type: z.literal('button-reference'),
			options: z.object({ location: ExpressionOrValueSchema, notes: z.string().optional() }).strict(),
		})
		.strict(),
])

const ControlPatchBodySchema = z
	.object({
		options: LayeredButtonInputSchema.shape.options.describe('Merged into the current options.'),
		style: LayeredButtonInputSchema.shape.style.describe('Replaces the whole style.'),
		feedbacks: LayeredButtonInputSchema.shape.feedbacks.describe('Replaces all feedbacks.'),
		steps: LayeredButtonInputSchema.shape.steps.describe('Replaces all steps and their actions.'),
		localVariables: LayeredButtonInputSchema.shape.localVariables.describe('Replaces all local variables.'),
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
		.describe(
			'If true, actions and feedbacks of connections that are not running (so have no definitions) are accepted with a warning instead of rejected.'
		),
})

const PressBodySchema = z
	.object({
		surfaceId: z.string().optional().describe('Surface to attribute the press to, as if pressed on it.'),
	})
	.strict()
	.optional()

const RotateBodySchema = z
	.object({
		direction: z.enum(['left', 'right']),
		surfaceId: z.string().optional(),
	})
	.strict()

const controlIdParam = z.object({
	controlId: z.string().describe('Control id.').meta({ example: 'bank:Qm4tR8zL2nH6vB1cX5kP0' }),
})

const locationParams = z.object({
	pageId: z.string().describe('Page id.').meta({ example: 'ggmHXCUQ0RRXUwEr8HHtQ' }),
	row: z.coerce.number().int().describe('Grid row.'),
	column: z.coerce.number().int().describe('Grid column.'),
})

// ---- Response schemas ----

const ControlLocationResponseSchema = z.object({
	pageId: z.string(),
	pageNumber: z.number().int(),
	row: z.number().int(),
	column: z.number().int(),
})

const WarningSchema = z.object({ path: z.string(), message: z.string() })

const ControlResponseExample = {
	controlId: 'bank:Qm4tR8zL2nH6vB1cX5kP0',
	location: { pageId: 'ggmHXCUQ0RRXUwEr8HHtQ', pageNumber: 1, row: 0, column: 1 },
	model: { type: 'pageup' },
	warnings: [],
}

const ControlResponseSchema = z
	.object({
		controlId: z.string().nullable().describe('Control id; null in a dry run that would create a new control.'),
		location: ControlLocationResponseSchema.nullable().describe('Where the control is placed, or null.'),
		model: z
			.object({ type: z.string() })
			.catchall(z.unknown())
			.describe('The control model as Companion stores it. Writable as-is with PUT.'),
		warnings: z.array(WarningSchema).describe('Things that could only be partly checked. Empty on reads.'),
	})
	.meta({ example: ControlResponseExample })

type ControlResponse = z.infer<typeof ControlResponseSchema>

/** Companion's model types are precise; the response schema types the model loosely */
function asResponseModel(model: SomeButtonModel): ControlResponse['model'] {
	return model as unknown as ControlResponse['model']
}

const extraWriteResponses = {
	409: { description: 'Conflict', content: { 'application/json': { schema: ErrorResponseSchema } } },
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
 * Create the controls router for /api/v2/controls/v1
 */
export function createControlsRestApiRouter(logger: Logger, deps: ControlsApiDeps): Express.Router {
	const controlsRouter = Express.Router()
	const context: ControlsRestContext = { ...deps, logger: logger.child({ source: 'controls/v1' }) }

	for (const endpointSpec of controlEndpointSpecs) {
		mountRestEndpoint(controlsRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(CONTROLS_API_BASE_PATH, controlsRouter)

	return router
}

export function registerControlPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of controlEndpointSpecs) {
		registerRestEndpoint(registry, CONTROLS_API_BASE_PATH, endpointSpec.contract)
	}
}

// ---- Helpers ----

/** The ETag of a control model. Entity ids and upgrade indexes are left out, as Companion regenerates them. */
function controlEtag(model: SomeButtonModel): string {
	return computeEtag(stripEntityIds(model))
}

function getGridControlOrThrow(ctx: ControlsRestContext, controlId: string) {
	if (!validateBankControlId(controlId)) throw RestApiError.notFound('Control not found')
	const control = ctx.controls.getControl(controlId)
	if (!control) throw RestApiError.notFound('Control not found')
	return control
}

function resolveLocation(ctx: ControlsRestContext, params: z.infer<typeof locationParams>) {
	const pageNumber = ctx.pageStore.getPageNumber(params.pageId)
	if (pageNumber === null) throw RestApiError.notFound('Page not found')

	const { minColumn, maxColumn, minRow, maxRow } = ctx.userconfig.getKey('gridSize')
	if (params.row < minRow || params.row > maxRow || params.column < minColumn || params.column > maxColumn) {
		throw RestApiError.badRequest(
			`Location is outside the grid (rows ${minRow} to ${maxRow}, columns ${minColumn} to ${maxColumn})`
		)
	}

	return { pageId: params.pageId, pageNumber, row: params.row, column: params.column }
}

function buildControlResponse(
	ctx: ControlsRestContext,
	controlId: string,
	warnings: ControlModelWarning[] = []
): { body: { data: ControlResponse }; etag: string } {
	const control = getGridControlOrThrow(ctx, controlId)
	const model = control.toJSON(true) as SomeButtonModel

	const location = ctx.pageStore.getLocationOfControlId(controlId)
	const pageId = location ? ctx.pageStore.getPageId(location.pageNumber) : undefined

	return {
		body: successResponse({
			controlId,
			location:
				location && pageId
					? { pageId, pageNumber: location.pageNumber, row: location.row, column: location.column }
					: null,
			model: asResponseModel(model),
			warnings,
		}),
		etag: controlEtag(model),
	}
}

/** Give entities without an id one (recursing into children), and parse the loosely typed children */
function normalizeEntities(entities: unknown[], path: string): SomeEntityModel[] {
	return entities.map((raw, index) => {
		const parsed = EntitySchema.safeParse(raw)
		if (!parsed.success) {
			throw RestApiError.badRequest(`Invalid entity at ${path}[${index}]`, parsed.error.format())
		}
		const entity = parsed.data
		return {
			...entity,
			id: entity.id ?? nanoid(),
			upgradeIndex: entity.upgradeIndex,
			children: entity.children
				? Object.fromEntries(
						Object.entries(entity.children).map(([groupId, list]) => [
							groupId,
							normalizeEntities(list, `${path}[${index}].children.${groupId}`),
						])
					)
				: undefined,
		} as SomeEntityModel
	})
}

function normalizeModelInput(input: z.infer<typeof ControlModelInputSchema>): SomeButtonModel {
	if (input.type !== 'button-layered') return input as SomeButtonModel

	return {
		...input,
		style: input.style
			? { layers: input.style.layers.map((element) => ({ ...element, id: element.id ?? nanoid() })) }
			: undefined,
		feedbacks: input.feedbacks ? normalizeEntities(input.feedbacks, 'feedbacks') : undefined,
		localVariables: input.localVariables ? normalizeEntities(input.localVariables, 'localVariables') : undefined,
		steps: input.steps
			? Object.fromEntries(
					Object.entries(input.steps).map(([stepId, step]) => [
						stepId,
						{
							...step,
							action_sets: Object.fromEntries(
								Object.entries(step.action_sets).map(([setId, list]) => [
									setId,
									normalizeEntities(list ?? [], `steps.${stepId}.action_sets.${setId}`),
								])
							),
						},
					])
				)
			: undefined,
	} as SomeButtonModel
}

/** Complete and validate a model, throwing 422 with every problem if it is not valid */
function prepareOrThrow(
	ctx: ControlsRestContext,
	model: SomeButtonModel,
	query: z.infer<typeof WriteQuerySchema>
): { model: SomeButtonModel; warnings: ControlModelWarning[] } {
	const prepared = prepareControlModel(model, ctx.definitions, {
		allowMissingDefinitions: query.allowMissingDefinitions === 'true',
	})
	if (prepared.errors.length > 0) {
		throw RestApiError.unprocessable('Control model is not valid', {
			errors: prepared.errors,
			warnings: prepared.warnings,
		})
	}
	return { model: prepared.model, warnings: prepared.warnings }
}

// ---- Endpoints ----

const controlEndpointSpecs: RestEndpointSpec<ControlsRestContext>[] = [
	defineControlEndpointSpec(
		{
			method: 'get',
			path: '/:controlId',
			scopes: ['read'],
			tags: CONTROLS_API_TAGS,
			summary: 'Get a control',
			description: 'Returns a grid control with its full model and location. The ETag header identifies this version.',
			request: { params: controlIdParam },
			response: { status: 200, description: 'The control', schema: createSuccessSchema(ControlResponseSchema) },
			examples: { response: successResponse(ControlResponseExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				const { body, etag } = buildControlResponse(ctx, params.controlId)
				return { body, headers: { ETag: etag } }
			}
		}
	),

	defineControlEndpointSpec(
		{
			method: 'get',
			path: '/locations/:pageId/:row/:column',
			scopes: ['read'],
			tags: CONTROLS_API_TAGS,
			summary: 'Get the control at a location',
			description: 'Returns the control placed at a grid location, or 404 if the location is empty.',
			request: { params: locationParams },
			response: { status: 200, description: 'The control', schema: createSuccessSchema(ControlResponseSchema) },
			examples: { response: successResponse(ControlResponseExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => {
				const location = resolveLocation(ctx, params)
				const controlId = ctx.pageStore.getControlIdAt(location)
				if (!controlId) throw RestApiError.notFound('No control at this location')

				const { body, etag } = buildControlResponse(ctx, controlId)
				return { body, headers: { ETag: etag } }
			}
		}
	),

	defineControlEndpointSpec(
		{
			method: 'put',
			path: '/locations/:pageId/:row/:column',
			scopes: ['write'],
			tags: CONTROLS_API_TAGS,
			summary: 'Create or replace the control at a location',
			description:
				'Write a whole control model to a grid location. Replacing keeps the control id; entity ids are regenerated. A layered button may leave out options, style, feedbacks, steps and localVariables, and style elements may leave out properties: defaults fill them in. Every action, feedback and style property is validated first; a 422 lists every problem with its path. Send If-Match to only replace a version you have seen (use "*" to require that a control exists).',
			request: { params: locationParams, query: WriteQuerySchema, body: ControlModelInputSchema },
			response: { status: 200, description: 'The written control', schema: createSuccessSchema(ControlResponseSchema) },
			examples: {
				body: { type: 'pageup' },
				response: successResponse(ControlResponseExample),
			},
			extraResponses: {
				...extraWriteResponses,
				201: {
					description: 'Created a new control',
					content: { 'application/json': { schema: createSuccessSchema(ControlResponseSchema) } },
				},
			},
			errorResponses,
		},
		(ctx) => {
			return ({ params, query, body, headers }) => {
				const location = resolveLocation(ctx, params)
				// May be undefined despite its type, for an empty location
				const existingId = ctx.pageStore.getControlIdAt(location) ?? null
				const existing = existingId ? ctx.controls.getControl(existingId) : undefined

				checkIfMatch(headers, existing ? controlEtag(existing.toJSON(true) as SomeButtonModel) : null)

				const { model, warnings } = prepareOrThrow(ctx, normalizeModelInput(body), query)

				if (query.dryRun === 'true') {
					return {
						body: successResponse({ controlId: existingId, location, model: asResponseModel(model), warnings }),
						headers: { ETag: controlEtag(model) },
					}
				}

				const controlId = ctx.controls.importControl(location, model, existingId ?? undefined)
				if (!controlId) throw new Error('Failed to write control')

				ctx.logger.info(
					`${existingId ? 'Replaced' : 'Created'} control ${controlId} at page ${location.pageNumber} ${location.row}/${location.column}`
				)

				const { body: responseBody, etag } = buildControlResponse(ctx, controlId, warnings)
				return {
					status: existingId ? 200 : 201,
					body: responseBody,
					headers: { ETag: etag },
					location: `${REST_API_BASE_PATH}${CONTROLS_API_BASE_PATH}/${controlId}`,
				}
			}
		}
	),

	defineControlEndpointSpec(
		{
			method: 'patch',
			path: '/:controlId',
			scopes: ['write'],
			tags: CONTROLS_API_TAGS,
			summary: 'Update a layered button',
			description:
				'Partially update a layered button. options is merged; style, feedbacks, steps and localVariables each replace the whole list when given. Validated like PUT. Send If-Match to only update a version you have seen.',
			request: { params: controlIdParam, query: WriteQuerySchema, body: ControlPatchBodySchema },
			response: { status: 200, description: 'The updated control', schema: createSuccessSchema(ControlResponseSchema) },
			examples: {
				body: { options: { notes: 'Generated by Planter' } },
				response: successResponse(ControlResponseExample),
			},
			extraResponses: extraWriteResponses,
			errorResponses,
		},
		(ctx) => {
			return ({ params, query, body, headers }) => {
				const control = getGridControlOrThrow(ctx, params.controlId)
				const current = control.toJSON(true) as SomeButtonModel
				if (current.type !== 'button-layered') {
					throw RestApiError.conflict(`Only layered buttons can be patched; this is a ${current.type}. Use PUT.`)
				}
				checkIfMatch(headers, controlEtag(current))

				const location = ctx.pageStore.getLocationOfControlId(params.controlId)
				if (!location) throw RestApiError.conflict('Control is not placed on the grid')

				// Only the parts in the body need normalizing; the rest is the control's own stored model
				const given = normalizeModelInput({ type: 'button-layered', ...body }) as typeof current
				const patched: SomeButtonModel = {
					...current,
					options: { ...current.options, ...given.options },
					style: given.style ?? current.style,
					feedbacks: given.feedbacks ?? current.feedbacks,
					steps: given.steps ?? current.steps,
					localVariables: given.localVariables ?? current.localVariables,
				}
				const { model, warnings } = prepareOrThrow(ctx, patched, query)

				if (query.dryRun === 'true') {
					const pageId = ctx.pageStore.getPageId(location.pageNumber)!
					return {
						body: successResponse({
							controlId: params.controlId,
							location: { pageId, ...location },
							model: asResponseModel(model),
							warnings,
						}),
						headers: { ETag: controlEtag(model) },
					}
				}

				if (!ctx.controls.importControl(location, model, params.controlId)) throw new Error('Failed to write control')
				ctx.logger.info(`Updated control ${params.controlId}`)

				const { body: responseBody, etag } = buildControlResponse(ctx, params.controlId, warnings)
				return { body: responseBody, headers: { ETag: etag } }
			}
		}
	),

	defineControlEndpointSpec(
		{
			method: 'delete',
			path: '/:controlId',
			scopes: ['write'],
			tags: CONTROLS_API_TAGS,
			summary: 'Delete a control',
			description:
				'Delete a grid control, leaving its location empty. Send If-Match to only delete a version you have seen.',
			request: { params: controlIdParam },
			response: { status: 204, description: 'Control deleted' },
			extraResponses: { 412: extraWriteResponses[412] },
			errorResponses,
		},
		(ctx) => {
			return ({ params, headers }) => {
				const control = getGridControlOrThrow(ctx, params.controlId)
				checkIfMatch(headers, controlEtag(control.toJSON(true) as SomeButtonModel))

				ctx.controls.deleteControl(params.controlId)
				ctx.logger.info(`Deleted control ${params.controlId}`)

				return { status: 204 }
			}
		}
	),

	...(['press', 'down', 'up'] as const).map((kind) =>
		defineControlEndpointSpec(
			{
				method: 'post',
				path: `/:controlId/${kind}`,
				scopes: ['execute'],
				tags: CONTROLS_API_TAGS,
				summary:
					kind === 'press'
						? 'Press and release a control'
						: kind === 'down'
							? 'Press a control (without releasing)'
							: 'Release a control',
				description:
					kind === 'press'
						? 'Runs the down actions, then the up actions, as a quick tap would.'
						: 'Use down and up separately to test holds and chords.',
				request: { params: controlIdParam, body: PressBodySchema },
				response: { status: 204, description: 'Done' },
				errorResponses,
			},
			(ctx) => {
				return ({ params, body }) => {
					getGridControlOrThrow(ctx, params.controlId)
					const surfaceId = body?.surfaceId

					if (kind !== 'up') ctx.controls.pressControl(params.controlId, true, surfaceId)
					if (kind !== 'down') ctx.controls.pressControl(params.controlId, false, surfaceId)

					return { status: 204 }
				}
			}
		)
	),

	defineControlEndpointSpec(
		{
			method: 'post',
			path: '/:controlId/rotate',
			scopes: ['execute'],
			tags: CONTROLS_API_TAGS,
			summary: 'Rotate a control',
			description: 'Runs the rotate_left or rotate_right actions of a button with rotary actions enabled.',
			request: { params: controlIdParam, body: RotateBodySchema },
			response: { status: 204, description: 'Done' },
			errorResponses,
		},
		(ctx) => {
			return ({ params, body }) => {
				getGridControlOrThrow(ctx, params.controlId)
				ctx.controls.rotateControl(params.controlId, body.direction === 'right' ? 1 : -1, body.surfaceId)
				return { status: 204 }
			}
		}
	),
]
