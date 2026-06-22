/**
 * `connect(config)` — the federation entry point. It opens a logical connection
 * to an external data source (a ClickHouse server, Postgres, MySQL, MongoDB,
 * object storage, a URL, or a local file) and lets you read from it through the
 * local chDB engine. The engine runs in-process; the data can live anywhere a
 * ClickHouse table function can reach.
 *
 * A `Connection` is a thin handle over a resolved source plan:
 *
 *   const pg = chdb.connect({ url: 'postgres://h/db', username, password })
 *   await chdb.selectFrom(pg.table('users').as('u'))
 *     .innerJoin(chTable.s3({ url, format: 'Parquet' }).as('e'), 'u.id', 'e.user_id')
 *     .selectAll().execute()
 *
 * Every host, credential, path, and option is bound server-side, so a
 * connection string never reaches the SQL text. The build phase is pure; only
 * the async methods touch the engine, where the typed Layer 1 errors surface.
 */

import type { ChdbResult } from '../../result'
import { ChdbCompileError } from '../../errors'
import { runtime } from '../runtime'
import type { ExecContext } from '../execute/terminal'
import { executeStatement } from '../execute/terminal'
import { parseRows } from '../execute/format'
import { compileExpr, compileQuery, type CompiledQuery } from '../compiler/compile'
import { ChExpression } from '../builder/expression'
import { buildSource, type ConnectConfig, type SourcePlan } from './url-scheme'
import { buildSnapshotNode } from './snapshot'

/** A column of `DESCRIBE TABLE`. */
export interface ColumnInfo {
  name: string
  type: string
  [key: string]: unknown
}

/** Build the `DESCRIBE TABLE <source>` statement for a table / location. */
export function compileDescribe(plan: SourcePlan, table?: string): CompiledQuery {
  const source = compileExpr(plan.table(table))
  return { sql: `DESCRIBE TABLE ${source.sql}`, parameters: source.parameters }
}

/** Build the database-listing query (ClickHouse server sources only). */
export function compileDatabases(plan: SourcePlan): CompiledQuery {
  requireClickHouse(plan, 'databases()')
  return compileQuery({
    kind: 'SelectQuery',
    from: plan.serverTable('system', 'databases'),
    selections: [{ kind: 'Reference', name: 'name' }],
    orderBy: [{ expr: { kind: 'Reference', name: 'name' }, direction: 'asc' }],
  })
}

/** Build the table-listing query, optionally scoped to one database. */
export function compileTables(plan: SourcePlan, database?: string): CompiledQuery {
  requireClickHouse(plan, 'tables()')
  return compileQuery({
    kind: 'SelectQuery',
    from: plan.serverTable('system', 'tables'),
    selections: [{ kind: 'Reference', name: 'name' }],
    where:
      database !== undefined
        ? {
            kind: 'Binary',
            left: { kind: 'Reference', name: 'database' },
            op: '=',
            right: { kind: 'Value', value: database, chType: 'String' },
          }
        : undefined,
    orderBy: [{ expr: { kind: 'Reference', name: 'name' }, direction: 'asc' }],
  })
}

function requireClickHouse(plan: SourcePlan, method: string): void {
  if (plan.sourceType !== 'clickhouse') {
    throw new ChdbCompileError(
      `${method} metadata discovery is only available for ClickHouse sources; use describe() for a ${plan.sourceType} source`,
    )
  }
}

/** A logical connection to one external data source. */
export class Connection {
  private readonly plan: SourcePlan

  constructor(
    private readonly ctx: ExecContext,
    config: ConnectConfig,
  ) {
    this.plan = buildSource(config)
  }

  /** The source family, e.g. `'postgres'`, `'s3'`, `'clickhouse'`. */
  get sourceType(): string {
    return this.plan.sourceType
  }

  /**
   * An aliasable source expression for a table/collection on this connection
   * (server sources), or for the configured location (object-storage / URL /
   * file sources, where the name is unused). Pass it to `selectFrom`/joins:
   *
   *   chdb.selectFrom(conn.table('schema.users').as('u'))
   */
  table(name?: string): ChExpression {
    return new ChExpression(this.plan.table(name))
  }

  /** Column names and types of a table/location (`DESCRIBE TABLE`). */
  async describe(table?: string): Promise<ColumnInfo[]> {
    return (await this.runRows(compileDescribe(this.plan, table))) as ColumnInfo[]
  }

  /** List database names (ClickHouse server sources only). */
  async databases(): Promise<string[]> {
    const rows = await this.runRows(compileDatabases(this.plan))
    return rows.map((r) => String(r.name))
  }

  /** List table names, optionally scoped to one database (ClickHouse only). */
  async tables(database?: string): Promise<string[]> {
    const rows = await this.runRows(compileTables(this.plan, database))
    return rows.map((r) => String(r.name))
  }

  /**
   * Copy a remote table into a local table once (`INSERT … SELECT`). There is
   * no ongoing sync — it reads the source a single time.
   */
  async snapshot(table: string, opts: { destination: string }): Promise<ChdbResult> {
    return executeStatement(this.ctx, buildSnapshotNode(this.plan, table, opts.destination))
  }

  private async runRows(compiled: CompiledQuery): Promise<Record<string, unknown>[]> {
    const runOpts = { format: 'JSONEachRow' }
    const result = this.ctx.session
      ? await this.ctx.session.queryBindAsync(compiled.sql, compiled.parameters, runOpts)
      : await runtime().queryBindAsync(compiled.sql, compiled.parameters, runOpts)
    return parseRows(result.text())
  }
}
