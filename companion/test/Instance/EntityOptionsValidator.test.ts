import { describe, expect, test } from 'vitest'
import type { ClientEntityDefinition } from '../../../shared-lib/lib/Model/EntityDefinitionModel.js'
import { EntityModelType } from '../../../shared-lib/lib/Model/EntityModel.js'
import { CompanionFieldVariablesSupport, type SomeCompanionInputField } from '../../../shared-lib/lib/Model/Options.js'
import { validateEntityOptions } from '../../lib/Instance/EntityOptionsValidator.js'

function createDefinition(
	options: SomeCompanionInputField[],
	props: Partial<ClientEntityDefinition> = {}
): ClientEntityDefinition {
	return {
		entityType: EntityModelType.Action,
		label: 'Test action',
		sortKey: null,
		description: undefined,
		options,
		optionsToMonitorForInvalidations: null,
		feedbackType: null,
		feedbackStyle: undefined,
		hasLifecycleFunctions: false,
		hasLearn: false,
		learnTimeout: undefined,
		showInvert: false,
		actionHasResult: false,
		feedbackAffectedProperties: undefined,
		optionsSupportExpressions: true,
		...props,
	} as ClientEntityDefinition
}

const value = (v: unknown) => ({ isExpression: false, value: v })
const expression = (v: string) => ({ isExpression: true, value: v })

const fields = {
	input: {
		id: 'input',
		type: 'dropdown',
		label: 'Input',
		default: 1,
		choices: [
			{ id: 1, label: 'Camera 1' },
			{ id: 2, label: 'Camera 2' },
		],
	},
	level: { id: 'level', type: 'number', label: 'Level', default: 0, min: 0, max: 100 },
	name: {
		id: 'name',
		type: 'textinput',
		label: 'Name',
		default: '',
		regex: '/^[a-z]+$/',
		useVariables: CompanionFieldVariablesSupport.Basic,
	},
	locked: { id: 'locked', type: 'number', label: 'Locked', default: 0, min: 0, max: 10, disableAutoExpression: true },
	check: { id: 'check', type: 'expression', label: 'Check', default: '1 == 1' },
} satisfies Record<string, SomeCompanionInputField>

describe('validateEntityOptions', () => {
	const definition = createDefinition(Object.values(fields))

	test('accepts valid literal values and expressions', () => {
		const result = validateEntityOptions(definition, {
			input: value(2),
			level: value(50),
			name: value('abc'),
			locked: value(3),
			check: expression('$(internal:time_s) > 10'),
		})

		expect(result).toEqual({ valid: true, errors: [], warnings: [] })
	})

	test('omitted options are not errors', () => {
		expect(validateEntityOptions(definition, {}).valid).toBe(true)
	})

	test('rejects unknown option ids', () => {
		const result = validateEntityOptions(definition, { nope: value(1) })

		expect(result.valid).toBe(false)
		expect(result.errors).toEqual([{ optionId: 'nope', code: 'unknown_option', message: 'Unknown option "nope"' }])
	})

	test('rejects bare values that are not in stored form', () => {
		const result = validateEntityOptions(definition, { input: 2 })

		expect(result.errors).toMatchObject([{ optionId: 'input', code: 'invalid_shape' }])
	})

	test('rejects dropdown values outside the choices', () => {
		const result = validateEntityOptions(definition, { input: value(7) })

		expect(result.errors).toMatchObject([{ optionId: 'input', code: 'invalid_value' }])
	})

	test('rejects numbers out of range', () => {
		const result = validateEntityOptions(definition, { level: value(150) })

		expect(result.errors).toEqual([
			{ optionId: 'level', code: 'invalid_value', message: 'Value must be less than or equal to 100' },
		])
	})

	test('rejects text that fails the field regex', () => {
		const result = validateEntityOptions(definition, { name: value('ABC') })

		expect(result.errors).toMatchObject([{ optionId: 'name', code: 'invalid_value' }])
	})

	test('only warns for text containing variables, since its content is known at run time', () => {
		const result = validateEntityOptions(definition, { name: value('$(internal:time_hms)') })

		expect(result.valid).toBe(true)
		expect(result.warnings).toMatchObject([{ optionId: 'name' }])
	})

	test('rejects expressions on fields that disable them', () => {
		const result = validateEntityOptions(definition, { locked: expression('1 + 1') })

		expect(result.errors).toMatchObject([{ optionId: 'locked', code: 'expression_not_allowed' }])
	})

	test('rejects expressions on definitions without expression support', () => {
		const legacy = createDefinition(Object.values(fields), { optionsSupportExpressions: false })
		const result = validateEntityOptions(legacy, { level: expression('1 + 1') })

		expect(result.errors).toMatchObject([{ optionId: 'level', code: 'expression_not_allowed' }])
	})

	test('still validates literal values on definitions without expression support', () => {
		const legacy = createDefinition(Object.values(fields), { optionsSupportExpressions: false })
		const result = validateEntityOptions(legacy, { input: value(7) })

		expect(result.errors).toMatchObject([{ optionId: 'input', code: 'invalid_value' }])
	})

	test('rejects expressions with invalid syntax', () => {
		const result = validateEntityOptions(definition, { level: expression('1 +') })

		expect(result.errors).toMatchObject([{ optionId: 'level', code: 'invalid_expression' }])
	})

	test('checks expression fields as expressions even when not flagged as one', () => {
		const result = validateEntityOptions(definition, { check: value('1 ==') })

		expect(result.errors).toMatchObject([{ optionId: 'check', code: 'invalid_expression' }])
	})

	test('rejects non-string expressions', () => {
		const result = validateEntityOptions(definition, { level: { isExpression: true, value: 5 } })

		expect(result.errors).toMatchObject([{ optionId: 'level', code: 'invalid_expression' }])
	})

	test('skips fields hidden by their isVisible logic', () => {
		const withVisibility = createDefinition([
			{ id: 'enabled', type: 'checkbox', label: 'Enabled', default: false, disableAutoExpression: true },
			{
				...fields.level,
				isVisibleUi: { type: 'expression', fn: '$(options:enabled)' },
			},
		])

		expect(validateEntityOptions(withVisibility, { enabled: value(false), level: value(150) }).valid).toBe(true)
		expect(validateEntityOptions(withVisibility, { enabled: value(true), level: value(150) }).valid).toBe(false)
	})

	test('does not error on fields that allow invalid values', () => {
		const lenient = createDefinition([{ ...fields.level, allowInvalidValues: true }])
		const result = validateEntityOptions(lenient, { level: value(150) })

		expect(result.valid).toBe(true)
		expect(result.warnings).toMatchObject([{ optionId: 'level', message: 'Value is above 100' }])
	})

	test('does not validate deferred fields, but warns', () => {
		const deferred = createDefinition([{ ...fields.level, deferParsing: true }])
		const result = validateEntityOptions(deferred, { level: value('anything') })

		expect(result.valid).toBe(true)
		expect(result.warnings).toMatchObject([{ optionId: 'level' }])
	})

	test('reports every problem, not just the first', () => {
		const result = validateEntityOptions(definition, { nope: value(1), input: value(7), level: value(-1) })

		expect(result.errors.map((e) => e.optionId).sort()).toEqual(['input', 'level', 'nope'])
	})
})
