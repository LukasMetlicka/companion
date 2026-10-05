import { nanoid } from 'nanoid'
import { elementSchemas, type ElementSchemaSection } from '@companion-app/shared/Graphics/ElementPropertiesSchemas.js'
import type {
	ButtonModelBase,
	LayeredButtonModel,
	NormalButtonSteps,
	SomeButtonModel,
} from '@companion-app/shared/Model/ButtonModel.js'
import type { EventDefinition } from '@companion-app/shared/Model/Common.js'
import type { ClientEntityDefinition } from '@companion-app/shared/Model/EntityDefinitionModel.js'
import { EntityModelType, type SomeEntityModel } from '@companion-app/shared/Model/EntityModel.js'
import type { SomeCompanionInputField } from '@companion-app/shared/Model/Options.js'
import type { SomeButtonGraphicsElement } from '@companion-app/shared/Model/StyleLayersModel.js'
import type { TriggerModel } from '@companion-app/shared/Model/TriggerModel.js'
import { validateInputValue } from '@companion-app/shared/ValidateInputValue.js'
import { validateEntityOptions, validateOptionValues } from '../Instance/EntityOptionsValidator.js'
import { CreateElementOfType } from './ControlTypes/Button/LayerDefaults.js'
import { ControlButtonLayered } from './ControlTypes/Button/Layered.js'
import { ControlTrigger } from './ControlTypes/Triggers/Trigger.js'

export type ControlModelIssueCode =
	| 'unknown_definition'
	| 'unknown_event_type'
	| 'wrong_entity_type'
	| 'unknown_child_group'
	| 'invalid_action_set'
	| 'unknown_option'
	| 'invalid_shape'
	| 'expression_not_allowed'
	| 'invalid_expression'
	| 'invalid_value'
	| 'invalid_layers'
	| 'unknown_element_type'
	| 'duplicate_element_id'
	| 'unknown_element_property'
	| 'invalid_style_override'

export interface ControlModelIssue {
	/** Where the problem is, e.g. `steps.0.action_sets.down[1].options.input` */
	path: string
	code: ControlModelIssueCode
	message: string
}

export interface ControlModelWarning {
	path: string
	message: string
}

export interface PreparedControlModel {
	/** The model, completed with Companion's defaults. Only safe to write if `errors` is empty. */
	model: SomeButtonModel
	errors: ControlModelIssue[]
	warnings: ControlModelWarning[]
}

export interface ControlModelValidatorDeps {
	getEntityDefinition(
		entityType: EntityModelType,
		connectionId: string,
		definitionId: string
	): ClientEntityDefinition | undefined
}

export interface ControlModelValidatorOptions {
	/**
	 * Report entities whose definition is unknown as warnings rather than errors. Definitions only exist
	 * while a connection is running, so this allows writing buttons for connections that are disabled.
	 */
	allowMissingDefinitions: boolean
}

/** Keys of a style element that are structure, not schema properties */
const ELEMENT_STRUCTURE_KEYS = new Set(['id', 'type', 'name', 'usage', 'pinnedProperties', 'children', 'elementId'])

const STANDARD_ACTION_SETS = new Set(['down', 'up', 'rotate_left', 'rotate_right'])

/**
 * Complete and validate a button model before it is written to Companion.
 *
 * Completion: a layered button may leave out `options`, `style`, `feedbacks`, `steps` and `localVariables`,
 * and each style element may leave out any of its properties; Companion's defaults fill them in.
 *
 * Validation goes beyond what Companion's own import checks: every action and feedback (including the
 * children of internal logic entities) must have a known definition of the right type and valid options,
 * every style element must be a known type with valid property values, and feedback style overrides must
 * point at an existing element property.
 */
export function prepareControlModel(
	input: SomeButtonModel,
	deps: ControlModelValidatorDeps,
	options: ControlModelValidatorOptions
): PreparedControlModel {
	const errors: ControlModelIssue[] = []
	const warnings: ControlModelWarning[] = []

	if (input.type !== 'button-layered') {
		// The other writable types have no entities or style to check
		return { model: structuredClone(input), errors, warnings }
	}

	const model = completeLayeredButton(input)

	const elementsById = checkLayers(model.style.layers, errors, warnings)

	const checker = new EntityChecker(deps, options, errors, warnings, elementsById)
	checker.checkList(model.feedbacks, EntityModelType.Feedback, 'feedbacks')
	checker.checkList(model.localVariables, EntityModelType.Feedback, 'localVariables')

	for (const [stepId, step] of Object.entries(model.steps)) {
		for (const [setId, actions] of Object.entries(step.action_sets)) {
			const path = `steps.${stepId}.action_sets.${setId}`
			if (!STANDARD_ACTION_SETS.has(setId) && !/^\d+$/.test(setId)) {
				errors.push({
					path,
					code: 'invalid_action_set',
					message: 'Action set must be down, up, rotate_left, rotate_right or a hold duration in milliseconds',
				})
				continue
			}
			if (setId.startsWith('rotate_') && actions?.length && !model.options.rotaryActions) {
				warnings.push({ path, message: 'Rotary action sets only run when options.rotaryActions is true' })
			}
			checker.checkList(actions ?? [], EntityModelType.Action, path)
		}
	}

	return { model, errors, warnings }
}

/** Fill in the parts of a layered button left out of the input, using the same defaults as a new button */
function completeLayeredButton(input: LayeredButtonModel): LayeredButtonModel {
	const partial = structuredClone(input) as Partial<LayeredButtonModel> & Pick<LayeredButtonModel, 'type'>

	const layers = partial.style?.layers ?? structuredClone(ControlButtonLayered.DefaultElements)

	return {
		type: 'button-layered',
		options: {
			stepProgression: 'auto',
			rotaryActions: false,
			canModifyStyleInApis: false,
			...partial.options,
		},
		style: { layers: layers.map(completeElement) },
		feedbacks: partial.feedbacks ?? [],
		steps: partial.steps ?? defaultSteps(),
		localVariables: partial.localVariables ?? [],
	}
}

/** The steps of a new button: one step with empty down and up action sets */
function defaultSteps(): NormalButtonSteps {
	return { 0: { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } } } as unknown as NormalButtonSteps
}

/** Fill in any properties an element leaves out from the defaults for its type */
function completeElement(element: SomeButtonGraphicsElement): SomeButtonGraphicsElement {
	if (!(element.type in elementSchemas)) return element // Reported by checkLayers

	const defaults =
		element.type === 'canvas'
			? structuredClone(ControlButtonLayered.DefaultElements.find((e) => e.type === 'canvas')!)
			: CreateElementOfType(element.type)

	const completed = { ...defaults, ...element }
	if (completed.type === 'group' && Array.isArray(completed.children)) {
		completed.children = completed.children.map(completeElement)
	}
	return completed
}

/**
 * Validate the style layers, returning every element by id for checking style overrides
 */
function checkLayers(
	layers: SomeButtonGraphicsElement[],
	errors: ControlModelIssue[],
	warnings: ControlModelWarning[]
): Map<string, SomeButtonGraphicsElement> {
	const elementsById = new Map<string, SomeButtonGraphicsElement>()

	if (layers[0]?.type !== 'canvas') {
		errors.push({ path: 'style.layers', code: 'invalid_layers', message: 'The first layer must be the canvas' })
	}

	const visit = (elements: SomeButtonGraphicsElement[], path: string, isTopLevel: boolean) => {
		elements.forEach((element, index) => {
			const elementPath = `${path}[${index}]`

			if (element.type === 'canvas' && !(isTopLevel && index === 0)) {
				errors.push({
					path: elementPath,
					code: 'invalid_layers',
					message: 'There can only be one canvas, as the first layer',
				})
			}

			if (elementsById.has(element.id)) {
				errors.push({
					path: `${elementPath}.id`,
					code: 'duplicate_element_id',
					message: `Element id "${element.id}" is used more than once`,
				})
			}
			elementsById.set(element.id, element)

			const schema: ElementSchemaSection[] | undefined = (elementSchemas as Record<string, ElementSchemaSection[]>)[
				element.type
			]
			if (!schema) {
				errors.push({
					path: `${elementPath}.type`,
					code: 'unknown_element_type',
					message: `Unknown element type "${element.type}"`,
				})
				return
			}

			const fields = schema.flatMap((section) => section.fields)
			const fieldIds = new Set(fields.map((field) => field.id))

			const values: Record<string, unknown> = {}
			for (const [key, value] of Object.entries(element)) {
				if (fieldIds.has(key)) {
					values[key] = value
				} else if (!ELEMENT_STRUCTURE_KEYS.has(key) && !key.startsWith('opt:')) {
					errors.push({
						path: `${elementPath}.${key}`,
						code: 'unknown_element_property',
						message: `Unknown property "${key}" for a ${element.type} element`,
					})
				}
			}

			const result = validateOptionValues(fields, true, values)
			for (const issue of result.errors) {
				errors.push({ path: `${elementPath}.${issue.optionId}`, code: issue.code, message: issue.message })
			}
			for (const warning of result.warnings) {
				warnings.push({ path: `${elementPath}.${warning.optionId}`, message: warning.message })
			}

			if (element.type === 'group' && Array.isArray(element.children)) {
				visit(element.children, `${elementPath}.children`, false)
			}
		})
	}
	visit(layers, 'style.layers', true)

	return elementsById
}

/** Checks entities against their definitions, recursing into child groups */
class EntityChecker {
	readonly #deps: ControlModelValidatorDeps
	readonly #options: ControlModelValidatorOptions
	readonly #errors: ControlModelIssue[]
	readonly #warnings: ControlModelWarning[]
	readonly #elementsById: Map<string, SomeButtonGraphicsElement>

	constructor(
		deps: ControlModelValidatorDeps,
		options: ControlModelValidatorOptions,
		errors: ControlModelIssue[],
		warnings: ControlModelWarning[],
		elementsById: Map<string, SomeButtonGraphicsElement>
	) {
		this.#deps = deps
		this.#options = options
		this.#errors = errors
		this.#warnings = warnings
		this.#elementsById = elementsById
	}

	checkList(entities: SomeEntityModel[], expectedType: EntityModelType, path: string): void {
		entities.forEach((entity, index) => this.#checkEntity(entity, expectedType, `${path}[${index}]`))
	}

	#checkEntity(entity: SomeEntityModel, expectedType: EntityModelType, path: string): void {
		if (entity.type !== expectedType) {
			this.#errors.push({
				path: `${path}.type`,
				code: 'wrong_entity_type',
				message: `Expected ${expectedType === EntityModelType.Action ? 'an action' : 'a feedback'} here, got ${entity.type}`,
			})
			return
		}

		const definition = this.#deps.getEntityDefinition(entity.type, entity.connectionId, entity.definitionId)
		if (!definition) {
			const message = `Unknown ${entity.type} "${entity.definitionId}" for connection "${entity.connectionId}" (definitions only exist while the connection is running)`
			if (this.#options.allowMissingDefinitions) {
				this.#warnings.push({ path, message })
			} else {
				this.#errors.push({ path, code: 'unknown_definition', message })
			}
			return
		}

		const result = validateEntityOptions(definition, entity.options ?? {})
		for (const issue of result.errors) {
			this.#errors.push({ path: `${path}.options.${issue.optionId}`, code: issue.code, message: issue.message })
		}
		for (const warning of result.warnings) {
			this.#warnings.push({ path: `${path}.options.${warning.optionId}`, message: warning.message })
		}

		if (entity.type === EntityModelType.Feedback) {
			entity.styleOverrides?.forEach((override, index) => {
				this.#checkStyleOverride(override.elementId, override.elementProperty, `${path}.styleOverrides[${index}]`)
			})
		}

		for (const [groupId, children] of Object.entries(entity.children ?? {})) {
			const group = definition.supportsChildGroups.find((g) => g.groupId === groupId)
			if (!group) {
				this.#errors.push({
					path: `${path}.children.${groupId}`,
					code: 'unknown_child_group',
					message: `"${entity.definitionId}" has no child group "${groupId}"`,
				})
				continue
			}
			this.checkList(children ?? [], group.type, `${path}.children.${groupId}`)
		}
	}

	#checkStyleOverride(elementId: string, elementProperty: string, path: string): void {
		const element = this.#elementsById.get(elementId)
		if (!element) {
			this.#errors.push({
				path: `${path}.elementId`,
				code: 'invalid_style_override',
				message: `No style element with id "${elementId}"`,
			})
			return
		}

		const schema = (elementSchemas as Record<string, ElementSchemaSection[]>)[element.type]
		const hasProperty = !!schema?.some((section) =>
			section.fields.some((field: SomeCompanionInputField) => field.id === elementProperty)
		)
		if (!hasProperty) {
			this.#errors.push({
				path: `${path}.elementProperty`,
				code: 'invalid_style_override',
				message: `A ${element.type} element has no property "${elementProperty}"`,
			})
		}
	}
}

export interface PreparedTriggerModel {
	/** The model, completed with Companion's defaults. Only safe to write if `errors` is empty. */
	model: TriggerModel
	errors: ControlModelIssue[]
	warnings: ControlModelWarning[]
}

/**
 * Complete and validate a trigger model before it is written to Companion.
 *
 * Completion: options, events, condition, actions and localVariables may be left out. Events get an id,
 * `enabled: true` and their definition's default option values where left out.
 *
 * Validation: events must be a known type with valid option values (events store plain values, not
 * expressions); conditions must be feedbacks, actions must be actions, and both are checked against their
 * definitions exactly as for buttons.
 */
export function prepareTriggerModel(
	input: Partial<TriggerModel> & Pick<TriggerModel, 'type'>,
	deps: ControlModelValidatorDeps,
	eventDefinitions: Readonly<Record<string, EventDefinition>>,
	options: ControlModelValidatorOptions
): PreparedTriggerModel {
	const errors: ControlModelIssue[] = []
	const warnings: ControlModelWarning[] = []

	const model: TriggerModel = {
		type: 'trigger',
		options: { ...structuredClone(ControlTrigger.DefaultOptions), ...input.options },
		events: [],
		condition: structuredClone(input.condition ?? []),
		actions: structuredClone(input.actions ?? []),
		localVariables: structuredClone(input.localVariables ?? []),
	}

	;(input.events ?? []).forEach((event, index) => {
		const path = `events[${index}]`
		const definition = Object.hasOwn(eventDefinitions, event.type) ? eventDefinitions[event.type] : undefined
		if (!definition) {
			errors.push({ path: `${path}.type`, code: 'unknown_event_type', message: `Unknown event type "${event.type}"` })
			return
		}

		const fieldsById = new Map(definition.options.map((field) => [field.id, field]))
		const eventOptions: Record<string, any> = {}
		for (const field of definition.options) {
			if ('default' in field && field.default !== undefined) eventOptions[field.id] = structuredClone(field.default)
		}
		for (const [optionId, value] of Object.entries(event.options ?? {})) {
			const field = fieldsById.get(optionId)
			if (!field) {
				errors.push({
					path: `${path}.options.${optionId}`,
					code: 'unknown_option',
					message: `Unknown option "${optionId}"`,
				})
				continue
			}
			const result = validateInputValue(field, value)
			if (result.validationError) {
				errors.push({ path: `${path}.options.${optionId}`, code: 'invalid_value', message: result.validationError })
			}
			for (const warning of result.validationWarnings) {
				warnings.push({ path: `${path}.options.${optionId}`, message: warning })
			}
			eventOptions[optionId] = value
		}

		model.events.push({
			id: event.id ?? nanoid(),
			type: event.type,
			enabled: event.enabled ?? true,
			...(event.headline !== undefined ? { headline: event.headline } : {}),
			options: eventOptions,
		})
	})

	const checker = new EntityChecker(deps, options, errors, warnings, new Map())
	checker.checkList(model.condition, EntityModelType.Feedback, 'condition')
	checker.checkList(model.actions, EntityModelType.Action, 'actions')
	checker.checkList(model.localVariables, EntityModelType.Feedback, 'localVariables')

	return { model, errors, warnings }
}

/** Entities without the ids and upgrade indexes Companion (re)generates on write, recursing into children */
function stripEntityListIds(entities: SomeEntityModel[] | undefined): unknown[] {
	return (entities ?? []).map((entity) => {
		const { id: _id, upgradeIndex: _upgradeIndex, children, ...rest } = entity
		return {
			...rest,
			...(children
				? {
						children: Object.fromEntries(
							Object.entries(children).map(([groupId, list]) => [groupId, stripEntityListIds(list)])
						),
					}
				: {}),
		}
	})
}

/** Button content for change detection: entity ids are left out, as they are regenerated on every write */
export function stripEntityIds(model: SomeButtonModel): unknown {
	if (!('feedbacks' in model)) return model

	const base = model as ButtonModelBase & SomeButtonModel
	return {
		...base,
		feedbacks: stripEntityListIds(base.feedbacks),
		localVariables: stripEntityListIds(base.localVariables),
		steps: Object.fromEntries(
			Object.entries(base.steps).map(([stepId, step]) => [
				stepId,
				{
					...step,
					action_sets: Object.fromEntries(
						Object.entries(step.action_sets).map(([setId, list]) => [setId, stripEntityListIds(list)])
					),
				},
			])
		),
	}
}

/** Trigger content for change detection: entity and event ids are left out, as they are (re)generated on write */
export function stripTriggerIds(model: TriggerModel): unknown {
	return {
		...model,
		actions: stripEntityListIds(model.actions),
		condition: stripEntityListIds(model.condition),
		localVariables: stripEntityListIds(model.localVariables),
		events: model.events.map(({ id: _id, ...rest }) => rest),
	}
}
