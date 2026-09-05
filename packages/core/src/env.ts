/**
 * Boolean switches read from the environment.
 *
 * Two policies, deliberately different, because the question each one answers
 * is different. A switch that is off until an operator turns it on must not be
 * turned on by a value nobody meant as a yes; a switch that is on until an
 * operator turns it off must not be turned off by one nobody meant as a no.
 * Anything unrecognised leaves the switch where it was, which for both is the
 * safe direction.
 *
 * What is shared is the vocabulary. Reading the same word two ways in one
 * program is its own bug: `SEARCHICUS_STORE=0` used to leave archiving on,
 * because that switch understood only the literal string "false" while
 * `MCP_ENABLED=0` next to it meant off.
 */
const AFFIRMATIVE = new Set(["true", "1", "yes", "on"]);
const NEGATIVE = new Set(["false", "0", "no", "off"]);

/** Off unless an operator says otherwise. Only an explicit yes counts. */
export function envOptIn(value: string | undefined): boolean {
  return value !== undefined && AFFIRMATIVE.has(value.trim().toLowerCase());
}

/** On unless an operator says otherwise. Only an explicit no counts. */
export function envOptOut(value: string | undefined): boolean {
  return value === undefined || !NEGATIVE.has(value.trim().toLowerCase());
}
