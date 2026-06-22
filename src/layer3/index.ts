/**
 * Layer 3 public surface — the fluent, immutable query builder. It borrows the
 * verb names and clause order of the Kysely v0.29.x shape but vendors none of
 * its runtime: a chain accumulates a node tree, `.compile()` emits
 * `{ sql, parameters }`, and execution forwards to Layer 1. Every user value is
 * bound server-side via `{pN:Type}` placeholders — no value is ever spliced into
 * the SQL string.
 *
 * This is a sibling of the pluggable Connection surface (`chdb/connection`), not
 * built on top of it; both sit directly on Layer 1.
 */

export { ChdbCompileError } from '../errors'

// AST node types (exported for `.compile()` consumers and tooling).
export type * from './compiler/nodes'
