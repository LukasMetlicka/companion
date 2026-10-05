import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import z from 'zod'
import type { CollectionBase } from '@companion-app/shared/Model/Collections.js'
import type { Logger } from '../Log/Controller.js'
import { REST_API_BASE_PATH } from '../Service/RestApi/constants.js'
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
import type { CollectionsBaseController } from './CollectionsBase.js'

/** The members of a collections controller the REST API uses */
export type CollectionsApiSource<TMeta> = Pick<
	CollectionsBaseController<TMeta>,
	| 'collectionData'
	| 'doesCollectionIdExist'
	| 'collectionCreate'
	| 'collectionRemove'
	| 'collectionSetName'
	| 'collectionMove'
> &
	// Present for collections that can be enabled and disabled (triggers)
	Partial<{
		setCollectionEnabled(collectionId: string, enabled: boolean | 'toggle'): void
		isCollectionEnabled(collectionId: string | null | undefined, onlyDirect?: boolean): boolean
	}>

export interface CollectionsResourceOptions<TMeta> {
	/** e.g. /triggers/v1/collections */
	basePath: string
	tags: string[]
	/** What is grouped, for documentation, e.g. "trigger" */
	noun: string
	/** Whether collections can be enabled and disabled */
	supportsEnabled: boolean
	/** Metadata for a new collection */
	createMetaData: (enabled: boolean) => TMeta
}

type CollectionsRestContext<TMeta> = { logger: Logger; source: CollectionsApiSource<TMeta> }

const CollectionResponseSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		parentId: z.string().nullable().describe('Id of the parent collection, or null at the top level.'),
		position: z.number().int().describe('Position among its siblings, from 0.'),
		enabled: z
			.boolean()
			.optional()
			.describe('Whether this collection itself is enabled (enable-able collections only).'),
		effectiveEnabled: z
			.boolean()
			.optional()
			.describe('Whether it is enabled taking its parents into account: items in it only run if this is true.'),
	})
	.meta({ example: { id: 'Wq7rT2', name: 'DIT', parentId: null, position: 0, enabled: true, effectiveEnabled: true } })

type CollectionResponse = z.infer<typeof CollectionResponseSchema>

const collectionIdParam = z.object({ collectionId: z.string().describe('Collection id.') })

/**
 * Build a REST resource for one kind of collections (triggers, custom variables, expression variables).
 * Collections are returned as a flat list in display order (depth first), each with its parent and
 * position, so the tree can be rebuilt without a recursive schema.
 */
export interface CollectionsResource<TMeta> {
	createRouter(logger: Logger, source: CollectionsApiSource<TMeta>): Express.Router
	registerPaths(registry: OpenAPIRegistry): void
}

export function createCollectionsResource<TMeta>(
	options: CollectionsResourceOptions<TMeta>
): CollectionsResource<TMeta> {
	const defineSpec = createRestEndpointSpecFactory<CollectionsRestContext<TMeta>>()

	const enabledField = z
		.boolean()
		.optional()
		.describe(options.supportsEnabled ? 'Whether the collection is enabled. Defaults to true.' : 'Not supported.')

	const CreateBodySchema = z
		.object({
			name: z.string().min(1),
			parentId: z.string().nullable().optional().describe('Parent collection, or null/omitted for the top level.'),
			position: z.number().int().min(0).optional().describe('Position among its siblings. Defaults to last.'),
			enabled: enabledField,
		})
		.strict()

	const PatchBodySchema = z
		.object({
			name: z.string().min(1).optional(),
			parentId: z
				.string()
				.nullable()
				.optional()
				.describe('Move under this collection; null for the top level; omit to stay in the same parent.'),
			position: z.number().int().min(0).optional().describe('New position among its siblings.'),
			enabled: enabledField,
		})
		.strict()

	const flatten = (source: CollectionsApiSource<TMeta>): CollectionResponse[] => {
		const result: CollectionResponse[] = []
		const visit = (collections: CollectionBase<TMeta>[], parentId: string | null) => {
			collections.forEach((collection, position) => {
				result.push({
					id: collection.id,
					name: collection.label,
					parentId,
					position,
					...(options.supportsEnabled
						? {
								enabled: !!(collection.metaData as { enabled?: boolean } | null)?.enabled,
								effectiveEnabled: source.isCollectionEnabled?.(collection.id) ?? true,
							}
						: {}),
				})
				visit(collection.children, collection.id)
			})
		}
		visit(source.collectionData, null)
		return result
	}

	const getOrThrow = (source: CollectionsApiSource<TMeta>, collectionId: string): CollectionResponse => {
		const found = flatten(source).find((c) => c.id === collectionId)
		if (!found) throw RestApiError.notFound('Collection not found')
		return found
	}

	const checkParent = (source: CollectionsApiSource<TMeta>, parentId: string | null | undefined) => {
		if (parentId && !flatten(source).some((c) => c.id === parentId)) {
			throw RestApiError.badRequest('Parent collection not found')
		}
	}

	const checkEnabledSupported = (enabled: boolean | undefined) => {
		if (enabled !== undefined && !options.supportsEnabled) {
			throw RestApiError.badRequest(`These collections cannot be enabled or disabled (${options.noun}s)`)
		}
	}

	/** Move a collection, refusing to move it into itself or one of its descendants */
	const move = (
		source: CollectionsApiSource<TMeta>,
		collectionId: string,
		parentId: string | null,
		position: number | undefined
	) => {
		const all = flatten(source)
		for (let id: string | null = parentId; id !== null; id = all.find((c) => c.id === id)?.parentId ?? null) {
			if (id === collectionId) throw RestApiError.badRequest('A collection cannot be moved into itself')
		}
		const siblingCount = all.filter((c) => c.parentId === parentId && c.id !== collectionId).length
		source.collectionMove(collectionId, parentId, Math.min(position ?? siblingCount, siblingCount))
	}

	const specs: RestEndpointSpec<CollectionsRestContext<TMeta>>[] = [
		defineSpec(
			{
				method: 'get',
				path: '/',
				scopes: ['read'],
				tags: options.tags,
				summary: `List ${options.noun} collections`,
				description: 'Returns every collection as a flat list in display order, each with its parent and position.',
				response: {
					status: 200,
					description: 'List of collections',
					schema: createCollectionSchema(CollectionResponseSchema),
				},
				errorResponses,
			},
			({ source }) => {
				return () => {
					const items = flatten(source)
					return { body: collectionResponse(items, { total: items.length, limit: items.length, offset: 0 }) }
				}
			}
		),

		defineSpec(
			{
				method: 'post',
				path: '/',
				scopes: ['write'],
				tags: options.tags,
				summary: `Create a ${options.noun} collection`,
				request: { body: CreateBodySchema },
				response: {
					status: 201,
					description: 'The created collection',
					schema: createSuccessSchema(CollectionResponseSchema),
				},
				errorResponses,
			},
			({ logger, source }) => {
				return ({ body }) => {
					checkEnabledSupported(body.enabled)
					checkParent(source, body.parentId)

					const id = source.collectionCreate(body.name, options.createMetaData(body.enabled ?? true))
					if (body.parentId || body.position !== undefined) move(source, id, body.parentId ?? null, body.position)

					logger.info(`Created ${options.noun} collection ${id} "${body.name}"`)

					return {
						status: 201,
						body: successResponse(getOrThrow(source, id)),
						location: `${REST_API_BASE_PATH}${options.basePath}/${id}`,
					}
				}
			}
		),

		defineSpec(
			{
				method: 'patch',
				path: '/:collectionId',
				scopes: ['write'],
				tags: options.tags,
				summary: `Update a ${options.noun} collection`,
				description: 'Rename, move or (if supported) enable/disable a collection. Fields left out are unchanged.',
				request: { params: collectionIdParam, body: PatchBodySchema },
				response: {
					status: 200,
					description: 'The updated collection',
					schema: createSuccessSchema(CollectionResponseSchema),
				},
				errorResponses,
			},
			({ logger, source }) => {
				return ({ params, body }) => {
					const current = getOrThrow(source, params.collectionId)
					checkEnabledSupported(body.enabled)
					checkParent(source, body.parentId)

					if (body.name !== undefined) source.collectionSetName(params.collectionId, body.name)
					if (body.parentId !== undefined || body.position !== undefined) {
						move(
							source,
							params.collectionId,
							body.parentId === undefined ? current.parentId : body.parentId,
							body.position
						)
					}
					if (body.enabled !== undefined) source.setCollectionEnabled?.(params.collectionId, body.enabled)

					logger.info(`Updated ${options.noun} collection ${params.collectionId}`)

					return { body: successResponse(getOrThrow(source, params.collectionId)) }
				}
			}
		),

		defineSpec(
			{
				method: 'delete',
				path: '/:collectionId',
				scopes: ['write'],
				tags: options.tags,
				summary: `Delete a ${options.noun} collection`,
				description: `Delete a collection. As in the web UI, its child collections move up to its parent, and the ${options.noun}s in it move to the top level; nothing else is deleted.`,
				request: { params: collectionIdParam },
				response: { status: 204, description: 'Collection deleted' },
				errorResponses,
			},
			({ logger, source }) => {
				return ({ params }) => {
					getOrThrow(source, params.collectionId)
					source.collectionRemove(params.collectionId)
					logger.info(`Deleted ${options.noun} collection ${params.collectionId}`)
					return { status: 204 }
				}
			}
		),
	]

	return {
		createRouter(logger: Logger, source: CollectionsApiSource<TMeta>): Express.Router {
			const inner = Express.Router()
			const context: CollectionsRestContext<TMeta> = { logger: logger.child({ source: options.basePath }), source }
			for (const spec of specs) mountRestEndpoint(inner, spec.createEndpoint(context))

			const router = Express.Router()
			router.use(options.basePath, inner)
			return router
		},
		registerPaths(registry: OpenAPIRegistry): void {
			for (const spec of specs) registerRestEndpoint(registry, options.basePath, spec.contract)
		},
	}
}
