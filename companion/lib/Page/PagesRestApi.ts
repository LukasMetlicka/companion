import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import Express from 'express'
import z from 'zod'
import type { ControlsController } from '../Controls/Controller.js'
import type { Logger } from '../Log/Controller.js'
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
import type { PageController } from './Controller.js'

export const PAGES_API_BASE_PATH = '/pages/v1'
const PAGES_API_TAGS = ['Pages']

/** Name Companion gives a page when none is supplied */
const DEFAULT_PAGE_NAME = 'PAGE'

/** The members of PageController this resource uses */
export type PagesApiPageController = Pick<
	PageController,
	'store' | 'insertPagesWithNavButtons' | 'deletePageAndControls' | 'clearPageAndControls' | 'movePage' | 'setPageName'
>

/** The members of ControlsController this resource uses */
export type PagesApiControls = Pick<ControlsController, 'getControl'>

type PagesRestContext = {
	logger: Logger
	pageController: PagesApiPageController
	controls: PagesApiControls
}

const definePageEndpointSpec = createRestEndpointSpecFactory<PagesRestContext>()

const PageSummaryExample = {
	id: 'ggmHXCUQ0RRXUwEr8HHtQ',
	number: 1,
	name: 'DIT',
	controlCount: 3,
}

const PageExample = {
	id: PageSummaryExample.id,
	number: PageSummaryExample.number,
	name: PageSummaryExample.name,
	controls: [
		{ row: 0, column: 0, controlId: 'bank:7Uq3hW2pY0aJk1sXcV9bN', type: 'pageup' },
		{ row: 0, column: 1, controlId: 'bank:Qm4tR8zL2nH6vB1cX5kP0', type: 'button-layered' },
	],
}

const PageSummaryResponseSchema = z
	.object({
		id: z.string().describe('Unique page id. Stable when pages are added, removed or reordered.'),
		number: z.number().int().describe('Current position of the page in the page list, starting at 1.'),
		name: z.string().describe('Display name of the page.'),
		controlCount: z.number().int().describe('Number of populated grid locations on the page.'),
	})
	.meta({ example: PageSummaryExample })

const PageControlLocationSchema = z.object({
	row: z.number().int().describe('Grid row of the control.'),
	column: z.number().int().describe('Grid column of the control.'),
	controlId: z.string().describe('Id of the control placed at this location.'),
	type: z
		.string()
		.nullable()
		.describe('Control type, e.g. button-layered, pageup, pagedown, pagenum; null if the control is missing.'),
})

const PageResponseSchema = z
	.object({
		id: PageSummaryResponseSchema.shape.id,
		number: PageSummaryResponseSchema.shape.number,
		name: PageSummaryResponseSchema.shape.name,
		controls: z.array(PageControlLocationSchema).describe('Populated grid locations, ordered by row then column.'),
	})
	.meta({ example: PageExample })

const PageCreateBodySchema = z
	.object({
		name: z.string().min(1).optional().describe(`Page name. Defaults to "${DEFAULT_PAGE_NAME}".`),
		number: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe('Position to insert the page at; later pages shift down. Defaults to the end of the list.'),
		defaultNavButtons: z
			.boolean()
			.default(true)
			.describe(
				'Whether to add the default page up / page number / page down buttons, as the web UI does. Set false when generating your own layout.'
			),
	})
	.strict()

const PagePatchBodySchema = z
	.object({
		name: z.string().min(1).optional().describe('New page name.'),
		number: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe('New position for the page; the pages in between shift to make room.'),
	})
	.strict()

const PageClearBodySchema = z
	.object({
		defaultNavButtons: z
			.boolean()
			.default(true)
			.describe('Whether to re-add the default page up / page number / page down buttons.'),
	})
	.strict()

const pageIdParam = z.object({
	pageId: z.string().describe('Page id, as returned by the list pages endpoint.').meta({ example: PageExample.id }),
})

const conflictResponse = {
	409: { description: 'Conflict', content: { 'application/json': { schema: ErrorResponseSchema } } },
}

type PageResponse = z.infer<typeof PageResponseSchema>

/**
 * Create the pages router for /api/v2/pages/v1
 */
export function createPagesRestApiRouter(
	logger: Logger,
	pageController: PagesApiPageController,
	controls: PagesApiControls
): Express.Router {
	const pagesRouter = Express.Router()
	const context: PagesRestContext = { logger: logger.child({ source: 'pages/v1' }), pageController, controls }

	for (const endpointSpec of pageEndpointSpecs) {
		mountRestEndpoint(pagesRouter, endpointSpec.createEndpoint(context))
	}

	const router = Express.Router()
	router.use(PAGES_API_BASE_PATH, pagesRouter)

	return router
}

export function registerPagePaths(registry: OpenAPIRegistry): void {
	for (const endpointSpec of pageEndpointSpecs) {
		registerRestEndpoint(registry, PAGES_API_BASE_PATH, endpointSpec.contract)
	}
}

/** Resolve a page id to its current number, or throw 404 */
function getPageNumberOrThrow(pageController: PagesApiPageController, pageId: string): number {
	const pageNumber = pageController.store.getPageNumber(pageId)
	if (pageNumber === null) throw RestApiError.notFound('Page not found')
	return pageNumber
}

function buildPageResponse(
	pageController: PagesApiPageController,
	controls: PagesApiControls,
	pageId: string
): PageResponse {
	const number = getPageNumberOrThrow(pageController, pageId)
	const page = pageController.store.getPagesById()[pageId]
	if (!page) throw RestApiError.notFound('Page not found')

	const locations: PageResponse['controls'] = []
	for (const [row, rowObj] of Object.entries(page.controls)) {
		if (!rowObj) continue
		for (const [column, controlId] of Object.entries(rowObj)) {
			locations.push({
				row: Number(row),
				column: Number(column),
				controlId,
				type: controls.getControl(controlId)?.type ?? null,
			})
		}
	}
	locations.sort((a, b) => a.row - b.row || a.column - b.column)

	return { id: page.id, number, name: page.name, controls: locations }
}

const pageEndpointSpecs: RestEndpointSpec<PagesRestContext>[] = [
	definePageEndpointSpec(
		{
			method: 'get',
			path: '/',
			scopes: ['read'],
			tags: PAGES_API_TAGS,
			summary: 'List all pages',
			description: 'Returns all pages in page order.',
			response: {
				status: 200,
				description: 'List of pages',
				schema: createCollectionSchema(PageSummaryResponseSchema),
			},
			examples: {
				response: collectionResponse([PageSummaryExample], { total: 1, limit: 1, offset: 0 }),
			},
			errorResponses,
		},
		({ pageController }) => {
			return () => {
				const pagesById = pageController.store.getPagesById()
				const pages = pageController.store.getPageIds().map((id, index) => {
					const page = pagesById[id]
					let controlCount = 0
					for (const rowObj of Object.values(page?.controls ?? {})) {
						if (rowObj) controlCount += Object.keys(rowObj).length
					}
					return { id, number: index + 1, name: page?.name ?? DEFAULT_PAGE_NAME, controlCount }
				})

				return { body: collectionResponse(pages, { total: pages.length, limit: pages.length, offset: 0 }) }
			}
		}
	),

	definePageEndpointSpec(
		{
			method: 'get',
			path: '/:pageId',
			scopes: ['read'],
			tags: PAGES_API_TAGS,
			summary: 'Get a page',
			description: 'Returns a page with the controls placed on its grid.',
			request: { params: pageIdParam },
			response: {
				status: 200,
				description: 'The requested page',
				schema: createSuccessSchema(PageResponseSchema),
			},
			examples: { response: successResponse(PageExample) },
			errorResponses,
		},
		({ pageController, controls }) => {
			return ({ params }) => {
				return { body: successResponse(buildPageResponse(pageController, controls, params.pageId)) }
			}
		}
	),

	definePageEndpointSpec(
		{
			method: 'post',
			path: '/',
			scopes: ['write'],
			tags: PAGES_API_TAGS,
			summary: 'Create a page',
			description: 'Insert a new page. Pages at or after the requested position shift down by one.',
			request: { body: PageCreateBodySchema },
			response: {
				status: 201,
				description: 'The created page',
				schema: createSuccessSchema(PageResponseSchema),
			},
			examples: {
				body: { name: 'DIT', number: 1, defaultNavButtons: false },
				response: successResponse({ ...PageExample, controls: [] }),
			},
			errorResponses,
		},
		({ logger, pageController, controls }) => {
			return ({ body }) => {
				const pageCount = pageController.store.getPageCount()
				const number = body.number ?? pageCount + 1
				if (number > pageCount + 1) {
					throw RestApiError.badRequest(`Page number must be between 1 and ${pageCount + 1}`)
				}

				const [pageId] = pageController.insertPagesWithNavButtons(
					number,
					[body.name ?? DEFAULT_PAGE_NAME],
					body.defaultNavButtons
				)
				if (!pageId) throw new Error('Failed to insert page')

				logger.info(`Created page "${body.name ?? DEFAULT_PAGE_NAME}" (${pageId}) at ${number}`)

				return {
					status: 201,
					body: successResponse(buildPageResponse(pageController, controls, pageId)),
					location: `${REST_API_BASE_PATH}${PAGES_API_BASE_PATH}/${pageId}`,
				}
			}
		}
	),

	definePageEndpointSpec(
		{
			method: 'patch',
			path: '/:pageId',
			scopes: ['write'],
			tags: PAGES_API_TAGS,
			summary: 'Update a page',
			description:
				'Rename a page and/or move it to a new position. Moving changes the numbers of the pages in between, but never their ids.',
			request: { params: pageIdParam, body: PagePatchBodySchema },
			response: {
				status: 200,
				description: 'The updated page',
				schema: createSuccessSchema(PageResponseSchema),
			},
			examples: {
				body: { name: 'DIT main', number: 2 },
				response: successResponse({ ...PageExample, name: 'DIT main', number: 2 }),
			},
			errorResponses,
		},
		({ logger, pageController, controls }) => {
			return ({ params, body }) => {
				const currentNumber = getPageNumberOrThrow(pageController, params.pageId)

				if (body.number !== undefined && body.number > pageController.store.getPageCount()) {
					throw RestApiError.badRequest(`Page number must be between 1 and ${pageController.store.getPageCount()}`)
				}

				if (body.name !== undefined) {
					pageController.setPageName(currentNumber, body.name)
					logger.info(`Renamed page ${params.pageId} to "${body.name}"`)
				}

				if (body.number !== undefined && body.number !== currentNumber) {
					if (!pageController.movePage(params.pageId, body.number)) throw new Error('Failed to move page')
					logger.info(`Moved page ${params.pageId} from ${currentNumber} to ${body.number}`)
				}

				return { body: successResponse(buildPageResponse(pageController, controls, params.pageId)) }
			}
		}
	),

	definePageEndpointSpec(
		{
			method: 'delete',
			path: '/:pageId',
			scopes: ['write'],
			tags: PAGES_API_TAGS,
			summary: 'Delete a page',
			description:
				'Delete a page and every control on it. Later pages shift up by one. The last remaining page cannot be deleted.',
			request: { params: pageIdParam },
			response: { status: 204, description: 'Page deleted' },
			extraResponses: conflictResponse,
			errorResponses,
		},
		({ logger, pageController }) => {
			return ({ params }) => {
				const number = getPageNumberOrThrow(pageController, params.pageId)

				if (!pageController.deletePageAndControls(number)) {
					throw RestApiError.conflict('Cannot delete the last page')
				}
				logger.info(`Deleted page ${params.pageId}`)

				return { status: 204 }
			}
		}
	),

	definePageEndpointSpec(
		{
			method: 'post',
			path: '/:pageId/clear',
			scopes: ['write'],
			tags: PAGES_API_TAGS,
			summary: 'Clear a page',
			description: `Delete every control on a page, clear its page variables and reset its name to "${DEFAULT_PAGE_NAME}", as the web UI does. The page keeps its id and position.`,
			request: { params: pageIdParam, body: PageClearBodySchema },
			response: {
				status: 200,
				description: 'The cleared page',
				schema: createSuccessSchema(PageResponseSchema),
			},
			examples: {
				body: { defaultNavButtons: false },
				response: successResponse({ ...PageExample, name: DEFAULT_PAGE_NAME, controls: [] }),
			},
			errorResponses,
		},
		({ logger, pageController, controls }) => {
			return ({ params, body }) => {
				const number = getPageNumberOrThrow(pageController, params.pageId)

				pageController.clearPageAndControls(number, body.defaultNavButtons)
				logger.info(`Cleared page ${params.pageId}`)

				return { body: successResponse(buildPageResponse(pageController, controls, params.pageId)) }
			}
		}
	),
]
