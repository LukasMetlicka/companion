import type Express from 'express'
import { stringifyError } from '@companion-app/shared/Stringify.js'
import LogController from '../../../Log/Controller.js'
import { RestApiError } from '../errors.js'

const logger = LogController.createLogger('Service/Rest/Errors')

/**
 * Global error handler for the REST API.
 * Converts RestApiError instances to structured JSON responses.
 *
 * Unexpected errors are logged with their stack, as the response deliberately hides them. Expected API
 * errors (4xx) are logged at debug level only. Request headers (and so tokens) are never logged.
 */
export function restApiErrorHandler(
	err: Error,
	req: Express.Request,
	res: Express.Response,
	_next: Express.NextFunction
): void {
	if (err instanceof RestApiError) {
		logger.debug(`${req.method} ${req.originalUrl} -> ${err.statusCode} ${err.code}: ${err.message}`)

		res.status(err.statusCode).json({
			error: {
				code: err.code,
				message: err.message,
				...(err.details !== undefined ? { details: err.details } : {}),
			},
		})
		return
	}

	// Unknown errors
	logger.error(`${req.method} ${req.originalUrl} failed with an unexpected error: ${stringifyError(err)}`)

	res.status(500).json({
		error: {
			code: 'INTERNAL_ERROR',
			message: 'An unexpected error occurred',
		},
	})
}
