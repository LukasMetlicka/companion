import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { registerControlPaths } from '../../Controls/ControlsRestApi.js'
import {
	expressionVariableCollectionsResource,
	registerExpressionVariablePaths,
} from '../../Controls/ExpressionVariablesRestApi.js'
import { registerPageVariablesPaths } from '../../Controls/PageVariablesRestApi.js'
import { registerTriggerPaths, triggerCollectionsResource } from '../../Controls/TriggersRestApi.js'
import { registerInstanceRestApiPaths } from '../../Instance/RestApi.js'
import { registerPagePaths } from '../../Page/PagesRestApi.js'
import type { AppInfo } from '../../Registry.js'
import { registerSurfacePaths } from '../../Surface/SurfacesRestApi.js'
import { customVariableCollectionsResource, registerVariablesPaths } from '../../Variables/VariablesRestApi.js'
import { REST_API_BASE_PATH } from './constants.js'
import { createOpenApiRegistry } from './registry.js'

/**
 * Generate the OpenAPI 3.0 JSON document from the registry.
 * All route modules register their paths before this is called.
 */
export function generateOpenApiDocument(
	appInfo: Pick<AppInfo, 'appVersion'>
): ReturnType<OpenApiGeneratorV3['generateDocument']> {
	const registry = createOpenApiRegistry()

	// Register all route paths into the registry
	registerInstanceRestApiPaths(registry)
	registerSurfacePaths(registry)
	registerPagePaths(registry)
	registerVariablesPaths(registry)
	registerControlPaths(registry)
	registerTriggerPaths(registry)
	registerExpressionVariablePaths(registry)
	registerPageVariablesPaths(registry)
	triggerCollectionsResource.registerPaths(registry)
	customVariableCollectionsResource.registerPaths(registry)
	expressionVariableCollectionsResource.registerPaths(registry)

	const generator = new OpenApiGeneratorV3(registry.definitions)

	return generator.generateDocument({
		openapi: '3.0.3',
		info: {
			title: 'Bitfocus Companion REST API',
			version: appInfo.appVersion,
			description: 'REST API for programmatic configuration management of Bitfocus Companion.',
		},
		servers: [{ url: REST_API_BASE_PATH, description: 'REST API (resources versioned independently)' }],
		security: [{ bearerAuth: [] }],
	})
}
