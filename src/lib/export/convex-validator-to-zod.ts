import { z } from 'zod';

/**
 * Structural view of a Convex value validator (`convex/values`).
 *
 * Only the properties this module reads are declared, so the same code works
 * against `v.object`, `v.optional`, `v.union`, `v.array`, `v.literal`, `v.record`
 * and the scalar kinds without importing Convex internals.
 */
export interface ConvexValidatorLike {
  kind: string;
  isOptional?: string;
  fields?: Record<string, ConvexValidatorLike>;
  element?: ConvexValidatorLike;
  members?: ConvexValidatorLike[];
  key?: ConvexValidatorLike;
  value?: unknown;
}

/**
 * Derives a Zod schema from a Convex validator.
 *
 * The Convex validators are the single source of truth for the stored shape, so
 * deriving instead of mirroring keeps the import validator free to drift: a new
 * field on `planDataFields` is accepted by the importer the moment it is stored.
 * Zod is used here only because it reports the failing field *path*, which the
 * Convex backend's own validation errors do not include.
 *
 * Objects are strict: an unknown field is reported instead of being silently
 * dropped on import.
 */
export function zodFromConvexValidator(validator: ConvexValidatorLike): z.ZodType {
  const schema = buildSchema(validator);
  return validator.isOptional === 'optional' ? schema.optional() : schema;
}

/** Derives a strict Zod object from a map of Convex validators (e.g. `planDataFields`). */
export function zodObjectFromValidators(fields: Record<string, ConvexValidatorLike>): z.ZodObject {
  return z.strictObject(mapValidators(fields));
}

function mapValidators(fields: Record<string, ConvexValidatorLike>): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(fields).map(([field, validator]) => [field, zodFromConvexValidator(validator)]));
}

function buildSchema(validator: ConvexValidatorLike): z.ZodType {
  switch (validator.kind) {
    case 'string':
    case 'bytes':
    // Document ids are strings at runtime.
    case 'id':
      return z.string();
    case 'float64':
    case 'int64':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'literal':
      return z.literal(validator.value as string | number | boolean);
    case 'any':
      return z.unknown();
    case 'array':
      return z.array(zodFromConvexValidator(requireElement(validator)));
    case 'object':
      return zodObjectFromValidators(validator.fields ?? {});
    case 'union':
      return z.union(requireMembers(validator).map(zodFromConvexValidator) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    case 'record':
      return z.record(z.string(), zodFromConvexValidator(requireRecordValue(validator)));
    default:
      throw new Error(`Unsupported Convex validator kind: ${validator.kind}`);
  }
}

function requireElement(validator: ConvexValidatorLike): ConvexValidatorLike {
  if (!validator.element) throw new Error('Array validator is missing its element validator');
  return validator.element;
}

function requireMembers(validator: ConvexValidatorLike): ConvexValidatorLike[] {
  const members = validator.members ?? [];
  if (members.length < 2) throw new Error('Union validator needs at least two members');
  return members;
}

function requireRecordValue(validator: ConvexValidatorLike): ConvexValidatorLike {
  if (!validator.value || typeof validator.value !== 'object') throw new Error('Record validator is missing its value validator');
  return validator.value as ConvexValidatorLike;
}
