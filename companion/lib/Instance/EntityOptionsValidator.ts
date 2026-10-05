import type { JsonValue } from 'type-fest'
import { ParseExpression } from '@companion-app/shared/Expressions.js'
import type { ClientEntityDefinition } from '@companion-app/shared/Model/EntityDefinitionModel.js'
import { isExpressionOrValue, type SomeCompanionInputField } from '@companion-app/shared/Model/Options.js'
import { validateInputValue } from '@companion-app/shared/ValidateInputValue.js'
import { computeHiddenEntityOptionFields } from '../Variables/Util.js'

export const ENTITY_OPTION_ISSUE_CODES = [
	'unknown_option',
	'invalid_shape',
	'expression_not_allowed',
	'invalid_expression',
	'invalid_value',
] as const
export type EntityOptionIssueCode = (typeof ENTITY_OPTION_ISSUE_CODES)[number]

export interface EntityOptionIssue {
	optionId: string
	code: EntityOptionIssueCode
	message: string
}

export interface EntityOptionWarning {
	optionId: string
	message: string
}

export interface EntityOptionsValidationResult {
	valid: boolean
	errors: EntityOptionIssue[]
	warnings: EntityOptionWarning[]
}

// Matches a `$(connection:variable)` reference, as parsed by the variables parser
const VARIABLE_REFERENCE_REGEX = /\$\([^:$)]+:[^)$]+\)/

/**
 * Validate a raw options object against an entity definition, before it is written anywhere.
 *
 * Options must be in the stored form: each value is `{ isExpression: false, value }` or
 * `{ isExpression: true, value: '<expression>' }`. Options left out are not errors; Companion fills
 * them with the field default.
 *
 * This is stricter than the run-time parse in VariablesAndExpressionParser: it rejects unknown
 * option ids, expressions on fields that can't be expressions, and literal values that fail the
 * field's own validation. Anything that can only be known at run time (expression results, values
 * containing variables) is checked for syntax only and reported as a warning.
 */
export function validateEntityOptions(
	definition: ClientEntityDefinition,
	options: Record<string, unknown>
): EntityOptionsValidationResult {
	return validateOptionValues(definition.options, definition.optionsSupportExpressions, options)
}

/**
 * Validate stored-form option values against a list of input fields. This is the core of
 * validateEntityOptions, also used for other expressionable property sets such as button style elements.
 *
 * @param fields The input fields the values belong to
 * @param supportsExpressions Whether values may be expressions (subject to each field's disableAutoExpression)
 * @param options The values, keyed by field id
 */
export function validateOptionValues(
	fields: SomeCompanionInputField[],
	supportsExpressions: boolean,
	options: Record<string, unknown>
): EntityOptionsValidationResult {
	const errors: EntityOptionIssue[] = []
	const warnings: EntityOptionWarning[] = []

	const fieldsById = new Map<string, SomeCompanionInputField>()
	for (const field of fields) fieldsById.set(field.id, field)
	// The visibility helper only reads these two members of a definition
	const definition = { options: fields, optionsSupportExpressions: supportsExpressions } as ClientEntityDefinition

	// Shape errors are reported first; the remaining checks only see well-formed values
	const wellFormed: Record<string, { isExpression: boolean; value: JsonValue | undefined }> = {}
	for (const [optionId, rawValue] of Object.entries(options)) {
		if (!fieldsById.has(optionId)) {
			errors.push({ optionId, code: 'unknown_option', message: `Unknown option "${optionId}"` })
			continue
		}
		if (!isExpressionOrValue(rawValue)) {
			errors.push({
				optionId,
				code: 'invalid_shape',
				message: 'Option value must be an object of the form { isExpression: boolean, value }',
			})
			continue
		}
		wellFormed[optionId] = rawValue
	}

	// Fields hidden by their isVisible logic are not validated, matching the run-time parse
	const hiddenFields = computeHiddenEntityOptionFields(definition, wellFormed as any)

	for (const [optionId, option] of Object.entries(wellFormed)) {
		const field = fieldsById.get(optionId)!
		if (hiddenFields.has(optionId)) continue

		// Deferred fields are parsed by the action itself, with context we don't have here
		if (field.deferParsing) {
			warnings.push({ optionId, message: 'Field is parsed by the action at run time; not validated' })
			continue
		}

		if (option.isExpression) {
			const expressionAllowed =
				field.type === 'expression' || (definition.optionsSupportExpressions && !field.disableAutoExpression)
			if (!expressionAllowed) {
				errors.push({
					optionId,
					code: 'expression_not_allowed',
					message: `Option "${optionId}" does not accept expressions`,
				})
				continue
			}
			checkExpressionSyntax(optionId, option.value, errors)
			continue
		}

		// 'expression' fields are always evaluated as expressions, even when not flagged as one
		if (field.type === 'expression') {
			checkExpressionSyntax(optionId, option.value, errors)
			continue
		}

		// Text that references variables is only known at run time; check the type, not the content
		if (
			field.type === 'textinput' &&
			field.useVariables &&
			typeof option.value === 'string' &&
			VARIABLE_REFERENCE_REGEX.test(option.value)
		) {
			warnings.push({ optionId, message: 'Value contains variables; its content is validated at run time' })
			continue
		}

		const result = validateInputValue(field, option.value)
		if (result.validationError && !field.allowInvalidValues) {
			errors.push({ optionId, code: 'invalid_value', message: result.validationError })
		}
		for (const warning of result.validationWarnings) {
			warnings.push({ optionId, message: warning })
		}
	}

	return { valid: errors.length === 0, errors, warnings }
}

function checkExpressionSyntax(optionId: string, value: JsonValue | undefined, errors: EntityOptionIssue[]): void {
	if (typeof value !== 'string') {
		errors.push({ optionId, code: 'invalid_expression', message: 'Expression must be a string' })
		return
	}
	try {
		ParseExpression(value)
	} catch (e) {
		errors.push({
			optionId,
			code: 'invalid_expression',
			message: `Expression is not valid: ${e instanceof Error ? e.message : String(e)}`,
		})
	}
}
