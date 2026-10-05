import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import z from 'zod'
import type { SurfaceGroupConfig } from '@companion-app/shared/Model/Surfaces.js'
import type { Logger } from '../Log/Controller.js'
import type { IPageStore } from '../Page/Store.js'
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
import type { SurfaceController } from './Controller.js'

export const SURFACE_GROUPS_API_BASE_PATH = '/surface-groups/v1'
const SURFACE_GROUPS_API_TAGS = ['Surfaces']

export interface SurfaceGroupsApiDeps {
	surfaces: Pick<
		SurfaceController,
		'getDevicesList' | 'getGroupConfig' | 'setGroupConfigKey' | 'devicePageSet' | 'devicePageGet'
	>
	pageStore: Pick<IPageStore, 'isPageIdValid'>
}

type SurfaceGroupsRestContext = SurfaceGroupsApiDeps & { logger: Logger }

const defineSurfaceGroupEndpointSpec = createRestEndpointSpecFactory<SurfaceGroupsRestContext>()

const SurfaceGroupExample = {
	id: 'streamdeck:CL12345',
	name: 'Stream Deck XL (CL12345)',
	isAutoGroup: true,
	surfaceIds: ['streamdeck:CL12345'],
	currentPageId: 'ggmHXCUQ0RRXUwEr8HHtQ',
	startupPageId: 'ggmHXCUQ0RRXUwEr8HHtQ',
	useLastPage: false,
	restrictPages: true,
	allowedPageIds: ['ggmHXCUQ0RRXUwEr8HHtQ'],
	neverLock: false,
}

const SurfaceGroupResponseSchema = z
	.object({
		id: z.string().describe('Group id. A surface that is not in a group has its own auto group, with its surface id.'),
		name: z.string(),
		isAutoGroup: z.boolean().describe('True for the implicit group of a single surface.'),
		surfaceIds: z.array(z.string()).describe('Surfaces in the group.'),
		currentPageId: z.string().nullable().describe('Page the group is showing, or null if it is offline.'),
		startupPageId: z.string().nullable().describe('Page shown at startup when useLastPage is false.'),
		useLastPage: z.boolean().describe('Start on the last page shown instead of startupPageId.'),
		restrictPages: z.boolean().describe('Only allow navigating to allowedPageIds.'),
		allowedPageIds: z.array(z.string()).describe('Pages the group may show when restrictPages is true.'),
		neverLock: z.boolean().describe('Never lock this group, even when the pincode lockout is active.'),
	})
	.meta({ example: SurfaceGroupExample })

type SurfaceGroupResponse = z.infer<typeof SurfaceGroupResponseSchema>

const SurfaceGroupPatchBodySchema = z
	.object({
		startupPageId: z.string().optional(),
		useLastPage: z.boolean().optional(),
		restrictPages: z.boolean().optional(),
		allowedPageIds: z.array(z.string()).optional(),
		neverLock: z.boolean().optional(),
		currentPageId: z
			.string()
			.optional()
			.describe('Switch the group to this page now (or, if offline, when it next connects).'),
	})
	.strict()

const groupIdParam = z.object({
	groupId: z
		.string()
		.describe('Surface group id, or a surface id for its auto group.')
		.meta({ example: SurfaceGroupExample.id }),
})

/**
 * Create the surface groups router for /api/v2/surface-groups/v1
 */
export function createSurfaceGroupsRestApiRouter(logger: Logger, deps: SurfaceGroupsApiDeps): Express.Router {
	const inner = Express.Router()
	const context: SurfaceGroupsRestContext = { ...deps, logger: logger.child({ source: 'surface-groups/v1' }) }

	for (const endpointSpec of surfaceGroupEndpointSpecs) {
		mountRestEndpoint(inner, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(SURFACE_GROUPS_API_BASE_PATH, inner)
	return router
}

export function registerSurfaceGroupPaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of surfaceGroupEndpointSpecs) {
		registerRestEndpoint(registry, SURFACE_GROUPS_API_BASE_PATH, endpointSpec.contract)
	}
}

function buildGroupResponse(
	ctx: SurfaceGroupsRestContext,
	group: { id: string; displayName: string; isAutoGroup: boolean; surfaces: { id: string }[] },
	config: SurfaceGroupConfig
): SurfaceGroupResponse {
	return {
		id: group.id,
		name: group.displayName,
		isAutoGroup: group.isAutoGroup,
		surfaceIds: group.surfaces.map((surface) => surface.id),
		currentPageId: ctx.surfaces.devicePageGet(group.id) ?? null,
		startupPageId: config.startup_page_id || null,
		useLastPage: config.use_last_page,
		restrictPages: !!config.restrict_pages,
		allowedPageIds: config.allowed_page_ids ?? [],
		neverLock: config.never_lock,
	}
}

function getGroupOrThrow(ctx: SurfaceGroupsRestContext, groupId: string): SurfaceGroupResponse {
	const group = ctx.surfaces.getDevicesList().find((g) => g.id === groupId)
	const config = ctx.surfaces.getGroupConfig(groupId)
	if (!group || !config) throw RestApiError.notFound('Surface group not found')
	return buildGroupResponse(ctx, group, config)
}

function setKeyOrThrow(ctx: SurfaceGroupsRestContext, groupId: string, key: string, value: unknown): void {
	let failure: string | undefined
	try {
		failure = ctx.surfaces.setGroupConfigKey(groupId, key, value as any)
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e)
	}
	if (failure) throw RestApiError.badRequest(`Could not set ${key}: ${failure}`)
}

const surfaceGroupEndpointSpecs: RestEndpointSpec<SurfaceGroupsRestContext>[] = [
	defineSurfaceGroupEndpointSpec(
		{
			method: 'get',
			path: '/',
			scopes: ['read'],
			tags: SURFACE_GROUPS_API_TAGS,
			summary: 'List surface groups',
			description:
				'Returns every surface group with its page settings, including the auto group of each surface that is not in a group.',
			response: {
				status: 200,
				description: 'List of surface groups',
				schema: createCollectionSchema(SurfaceGroupResponseSchema),
			},
			examples: { response: collectionResponse([SurfaceGroupExample], { total: 1, limit: 1, offset: 0 }) },
			errorResponses,
		},
		(ctx) => {
			return () => {
				const items = ctx.surfaces.getDevicesList().flatMap((group) => {
					const config = ctx.surfaces.getGroupConfig(group.id)
					return config ? [buildGroupResponse(ctx, group, config)] : []
				})
				return { body: collectionResponse(items, { total: items.length, limit: items.length, offset: 0 }) }
			}
		}
	),

	defineSurfaceGroupEndpointSpec(
		{
			method: 'get',
			path: '/:groupId',
			scopes: ['read'],
			tags: SURFACE_GROUPS_API_TAGS,
			summary: 'Get a surface group',
			request: { params: groupIdParam },
			response: {
				status: 200,
				description: 'The surface group',
				schema: createSuccessSchema(SurfaceGroupResponseSchema),
			},
			examples: { response: successResponse(SurfaceGroupExample) },
			errorResponses,
		},
		(ctx) => {
			return ({ params }) => ({ body: successResponse(getGroupOrThrow(ctx, params.groupId)) })
		}
	),

	defineSurfaceGroupEndpointSpec(
		{
			method: 'patch',
			path: '/:groupId',
			scopes: ['write'],
			tags: SURFACE_GROUPS_API_TAGS,
			summary: 'Update the page settings of a surface group',
			description:
				'Set the startup page, page restrictions and lock behaviour, and optionally switch page now. Restrictions are applied before the page switch, so with restrictPages on, a currentPageId outside allowedPageIds is refused (409). Fields left out are unchanged.',
			request: { params: groupIdParam, body: SurfaceGroupPatchBodySchema },
			response: {
				status: 200,
				description: 'The updated surface group',
				schema: createSuccessSchema(SurfaceGroupResponseSchema),
			},
			examples: {
				body: {
					restrictPages: true,
					allowedPageIds: ['ggmHXCUQ0RRXUwEr8HHtQ'],
					startupPageId: 'ggmHXCUQ0RRXUwEr8HHtQ',
					useLastPage: false,
					currentPageId: 'ggmHXCUQ0RRXUwEr8HHtQ',
				},
				response: successResponse(SurfaceGroupExample),
			},
			extraResponses: {
				409: {
					description: 'The page is not allowed for this group',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
			errorResponses,
		},
		(ctx) => {
			return ({ params, body }) => {
				getGroupOrThrow(ctx, params.groupId)

				// Check every page up front, so nothing changes if one is wrong
				const pageIds = [
					...(body.allowedPageIds ?? []),
					...(body.startupPageId ? [body.startupPageId] : []),
					...(body.currentPageId ? [body.currentPageId] : []),
				]
				const unknown = pageIds.filter((pageId) => !ctx.pageStore.isPageIdValid(pageId))
				if (unknown.length > 0) throw RestApiError.badRequest(`Unknown page ids: ${unknown.join(', ')}`)

				// Restrictions first, so a page switch below is checked against them
				if (body.allowedPageIds !== undefined)
					setKeyOrThrow(ctx, params.groupId, 'allowed_page_ids', body.allowedPageIds)
				if (body.restrictPages !== undefined) setKeyOrThrow(ctx, params.groupId, 'restrict_pages', body.restrictPages)
				if (body.startupPageId !== undefined) setKeyOrThrow(ctx, params.groupId, 'startup_page_id', body.startupPageId)
				if (body.useLastPage !== undefined) setKeyOrThrow(ctx, params.groupId, 'use_last_page', body.useLastPage)
				if (body.neverLock !== undefined) setKeyOrThrow(ctx, params.groupId, 'never_lock', body.neverLock)

				if (body.currentPageId !== undefined) {
					const after = getGroupOrThrow(ctx, params.groupId)
					if (after.restrictPages && !after.allowedPageIds.includes(body.currentPageId)) {
						throw RestApiError.conflict('This page is not in the allowed pages of the group')
					}

					if (ctx.surfaces.devicePageGet(params.groupId) !== undefined) {
						ctx.surfaces.devicePageSet(params.groupId, body.currentPageId)
					} else {
						// Offline: it shows its last page when it connects (if useLastPage)
						setKeyOrThrow(ctx, params.groupId, 'last_page_id', body.currentPageId)
					}
				}

				ctx.logger.info(`Updated page settings of surface group ${params.groupId}`)

				return { body: successResponse(getGroupOrThrow(ctx, params.groupId)) }
			}
		}
	),
]
