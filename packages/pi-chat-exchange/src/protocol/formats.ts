/**
 * Shared JSON Schema format validators for frozen protocol schemas.
 *
 * TypeBox's `Value.Check` rejects `format` keywords that have no registered
 * validator, so the `date-time` formats used across the protocol are
 * registered exactly once, here. Validation is strict ISO 8601 with an
 * explicit zone designator (Z or ±hh:mm); the protocol always serializes
 * timestamps in UTC `Z` form.
 */
import { FormatRegistry } from "@sinclair/typebox";

const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

FormatRegistry.Set("date-time", (value: unknown) =>
  typeof value === "string" && DATE_TIME_PATTERN.test(value));
