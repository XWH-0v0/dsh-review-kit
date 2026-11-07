/**
 * Minimal JSON-Schema checker for the schema subset this plugin declares
 * (type / properties / required / additionalProperties / items / enum).
 * It exists so the end-to-end harness can prove the tool value matches
 * OUTPUT_SCHEMA instead of eyeballing it.
 *
 * @param {object} schema schema node.
 * @param {unknown} value candidate value.
 * @param {string} [path] starting path label.
 * @returns {string[]} human-readable violations (empty when valid).
 */
export function validateSchema(schema, value, path = '$') {
  const errors = []
  visit(schema, value, path, errors)
  return errors
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesType(expected, value) {
  if (expected === 'object') return isPlainObject(value)
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'integer') return Number.isInteger(value)
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (expected === 'null') return value === null
  return typeof value === expected
}

function visit(schema, value, path, errors) {
  if (!isPlainObject(schema)) return

  if (typeof schema.type === 'string' && !matchesType(schema.type, value)) {
    errors.push(`${path}: 期望 ${schema.type}，实际 ${typeName(value)}`)
    return
  }

  if (Array.isArray(schema.enum)) {
    const serialized = JSON.stringify(value)
    if (!schema.enum.some((item) => JSON.stringify(item) === serialized)) {
      errors.push(`${path}: ${serialized} 不在 enum 中`)
    }
  }

  if (schema.type === 'array' && isPlainObject(schema.items)) {
    value.forEach((item, index) => visit(schema.items, item, `${path}[${index}]`, errors))
  }

  if (isPlainObject(value) && (schema.type === 'object' || schema.properties !== undefined)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: 缺少必填字段`)
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        visit(properties[key], child, `${path}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: 不允许的额外字段`)
      }
    }
  }
}
