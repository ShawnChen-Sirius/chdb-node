#!/usr/bin/env node
/**
 * `chdb gen-types` — introspect a data source and write a TypeScript Database
 * interface (column types as ClickHouse string literals) ready to feed into
 * `chdb.database<Db>()`. The CLI is a thin wrapper over `introspectDatabase`
 * and `emitDatabase`; everything programmatic lives in those two modules.
 *
 * Source modes:
 *   --from-file <path>          DESCRIBE a local file via the file() table function
 *   --from-table <name>         DESCRIBE a local table (the default connection)
 *   --from-url <url>            Open via connect() and DESCRIBE
 *
 * Common options:
 *   --table <name>              Repeatable. Server sources (--from-url postgres://...,
 *                               mysql://, clickhouse://) need at least one. Each
 *                               becomes a property on the emitted interface.
 *   --format <fmt>              File format (auto-detected if omitted)
 *   --structure <ddl>           File structure (auto-detected if omitted)
 *   --name <Db>                 Emitted interface name (default: Database)
 *   --out <path>                Write to file (default: stdout)
 *   --label <label>             Override the property name in the interface
 *                               (default: the table name or "file" / "stdin")
 */

import { writeFileSync } from 'fs'
import { introspectDatabase, type IntrospectSource } from './introspect'
import { emitDatabase } from './emit'

interface ParsedArgs {
  fromFile?: string
  fromTable?: string
  fromUrl?: string
  tables: string[]
  format?: string
  structure?: string
  name?: string
  out?: string
  label?: string
  username?: string
  password?: string
  database?: string
  help: boolean
  version: boolean
}

const HELP = `Usage: chdb gen-types [options]

One source mode is required:
  --from-file <path>            DESCRIBE a local file (file() table function)
  --from-table <name>           DESCRIBE a local table on the default connection
  --from-url <url>              Open the url via connect() and DESCRIBE

Options:
  --table <name>                Server sources need at least one (repeatable).
                                Becomes a property on the interface.
  --format <fmt>                File format (auto-detected if omitted).
  --structure <ddl>             File structure (auto-detected if omitted).
  --username <u> --password <p> Credentials for --from-url (override the url).
  --database <d>                Default database for --from-url.
  --name <Db>                   Interface name (default: Database).
  --out <path>                  Write to file (default: stdout).
  --label <label>               Override the single-source property name.
  -h, --help                    Show this help.
  -V, --version                 Show the package version.`

/** Tiny zero-dependency arg parser — accepts `--key value` and `--key=value`. */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = { tables: [], help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') { out.help = true; continue }
    if (a === '-V' || a === '--version') { out.version = true; continue }
    const eq = a.indexOf('=')
    const key = eq === -1 ? a : a.slice(0, eq)
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1)
    if (value === undefined) throw new Error(`Missing value for ${key}`)
    switch (key) {
      case '--from-file': out.fromFile = value; break
      case '--from-table': out.fromTable = value; break
      case '--from-url': out.fromUrl = value; break
      case '--table': out.tables.push(value); break
      case '--format': out.format = value; break
      case '--structure': out.structure = value; break
      case '--name': out.name = value; break
      case '--out': out.out = value; break
      case '--label': out.label = value; break
      case '--username': out.username = value; break
      case '--password': out.password = value; break
      case '--database': out.database = value; break
      default: throw new Error(`Unknown option ${key}`)
    }
  }
  return out
}

/** Turn parsed args into the `{ label → source }` map `introspectDatabase` takes. */
export function planSources(args: ParsedArgs): Record<string, IntrospectSource> {
  const modes = [args.fromFile, args.fromTable, args.fromUrl].filter((v) => v !== undefined).length
  if (modes === 0) throw new Error('Pick one source mode: --from-file, --from-table, or --from-url')
  if (modes > 1) throw new Error('Pick exactly one source mode (--from-file / --from-table / --from-url)')

  if (args.fromFile !== undefined) {
    const label = args.label ?? 'file'
    return { [label]: { kind: 'file', path: args.fromFile, format: args.format, structure: args.structure } }
  }
  if (args.fromTable !== undefined) {
    const label = args.label ?? args.fromTable
    return { [label]: { kind: 'table', name: args.fromTable } }
  }
  if (args.fromUrl !== undefined) {
    if (args.tables.length === 0) {
      throw new Error('--from-url requires at least one --table <name> (try --table information_schema.tables to discover names first)')
    }
    const config = {
      url: args.fromUrl,
      username: args.username,
      password: args.password,
      database: args.database,
    }
    const sources: Record<string, IntrospectSource> = {}
    for (const t of args.tables) sources[t] = { kind: 'url', config, table: t }
    return sources
  }
  /* istanbul ignore next */
  throw new Error('unreachable')
}

/** Run the CLI end-to-end; returns the TS source it would emit (also writes when --out is given). */
export async function main(argv: ReadonlyArray<string>, writers: { stdout: (s: string) => void; stderr: (s: string) => void } = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}): Promise<{ code: number; output?: string }> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    writers.stderr(`${(e as Error).message}\n\n${HELP}\n`)
    return { code: 2 }
  }
  if (args.help) {
    writers.stdout(`${HELP}\n`)
    return { code: 0 }
  }
  if (args.version) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json') as { version: string }
    writers.stdout(`${pkg.version}\n`)
    return { code: 0 }
  }
  let plan: Record<string, IntrospectSource>
  try {
    plan = planSources(args)
  } catch (e) {
    writers.stderr(`${(e as Error).message}\n`)
    return { code: 2 }
  }

  let db
  try {
    db = await introspectDatabase(plan)
  } catch (e) {
    writers.stderr(`gen-types: ${(e as Error).message}\n`)
    return { code: 1 }
  }

  const banner = describeBanner(args)
  const ts = emitDatabase(db, { interfaceName: args.name, banner })
  if (args.out !== undefined) {
    writeFileSync(args.out, ts)
  } else {
    writers.stdout(ts)
  }
  return { code: 0, output: ts }
}

function describeBanner(args: ParsedArgs): string {
  if (args.fromFile !== undefined) return `source: file ${args.fromFile}`
  if (args.fromTable !== undefined) return `source: table ${args.fromTable}`
  if (args.fromUrl !== undefined) {
    const u = new URL(args.fromUrl)
    // Don't leak credentials in the banner — show scheme://host only.
    return `source: ${u.protocol}//${u.host}${u.pathname}  tables: ${args.tables.join(', ')}`
  }
  return ''
}

/* istanbul ignore next */
if (require.main === module) {
  void main(process.argv.slice(2)).then((r) => process.exit(r.code))
}
