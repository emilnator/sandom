// Public option records are closed: an unknown field is a caller error, not
// a silently ignored key. Every public entry validates its options here so a
// misspelled option (`devicePixelRatio` for `deviceScale`) fails at the call.
export function validateClosedRecord(value, allowedFields, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a record`);
  }
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`${name} contains unknown field ${field}`);
    }
  }
}
