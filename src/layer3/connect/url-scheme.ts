/**
 * Maps a connection URL to a ClickHouse table function. `connect()` takes a
 * single `url` whose scheme selects the data source (Postgres, MySQL, S3, a
 * ClickHouse server, a local file, …) plus flat auth/config fields; this module
 * turns that into a table-function expression the builder can read from.
 *
 * Every credential, host, path, and option is carried as a bound value
 * (`{pN:Type}`), exactly like a value in a WHERE clause — chDB accepts bound
 * parameters in table-function argument position, so a URL, password, or bucket
 * name is always data and never spliced into the SQL string.
 */

import { ChdbCompileError } from '../../errors'
import type { Expr } from '../compiler/nodes'

/** A server source (host + table) versus a self-contained location (a URL/path). */
export type SourceKind = 'server' | 'location'

/**
 * Configuration accepted by `connect()`. The shape mirrors
 * `@clickhouse/client.createClient`: a `url` field whose scheme drives the
 * source type, plus flat auth/config fields named to match that client. Fields
 * not applicable to the chosen scheme are ignored.
 */
export interface ConnectConfig {
  /** Data-source address; the scheme selects the source type. Required. */
  url: string
  username?: string
  password?: string
  /** Default database (ClickHouse / Postgres / MySQL). */
  database?: string
  /** TLS toggle for a ClickHouse server source (cloud is always secure). */
  secure?: boolean
  /** ClickHouse server settings, forwarded when the source is ClickHouse. */
  clickhouseSettings?: Record<string, string | number | boolean>
  /** Supabase service-role key (used as the password when set). */
  serviceRoleKey?: string
  /** Supabase anon key (used as the password when no service-role key is set). */
  anonKey?: string
  /** Default schema for Postgres / Supabase (a dotted table name overrides it). */
  schema?: string
  /** Cloud region for object-storage sources (reserved; not yet positional). */
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** Session token for temporary object-storage credentials (reserved). */
  sessionToken?: string
  /** Data format for object-storage / URL / file sources (sniffed if omitted). */
  format?: string
  /** Extra HTTP headers for a URL source (reserved; not yet positional). */
  headers?: Record<string, string>
  /** Catalog config for an Iceberg source (reserved; not yet positional). */
  catalogConfig?: Record<string, unknown>
}

interface SchemeSpec {
  /** Stable label for the source family (used by metadata discovery). */
  sourceType: string
  /** The ClickHouse table function this scheme reads through. */
  fn: string
  kind: SourceKind
}

// URL scheme (URL.protocol, with its trailing colon) → table function.
const SCHEMES: Readonly<Record<string, SchemeSpec>> = {
  'clickhouse:': { sourceType: 'clickhouse', fn: 'remote', kind: 'server' },
  'clickhouse-cloud:': { sourceType: 'clickhouse', fn: 'remoteSecure', kind: 'server' },
  'supabase:': { sourceType: 'postgres', fn: 'postgresql', kind: 'server' },
  'postgres:': { sourceType: 'postgres', fn: 'postgresql', kind: 'server' },
  'postgresql:': { sourceType: 'postgres', fn: 'postgresql', kind: 'server' },
  'mysql:': { sourceType: 'mysql', fn: 'mysql', kind: 'server' },
  'mongodb:': { sourceType: 'mongodb', fn: 'mongodb', kind: 'server' },
  'mongodb+srv:': { sourceType: 'mongodb', fn: 'mongodb', kind: 'server' },
  's3:': { sourceType: 's3', fn: 's3', kind: 'location' },
  'gcs:': { sourceType: 'gcs', fn: 'gcs', kind: 'location' },
  'gs:': { sourceType: 'gcs', fn: 'gcs', kind: 'location' },
  'azureblob:': { sourceType: 'azure', fn: 'azureBlobStorage', kind: 'location' },
  'iceberg:': { sourceType: 'iceberg', fn: 'iceberg', kind: 'location' },
  'delta:': { sourceType: 'delta', fn: 'deltaLake', kind: 'location' },
  'hudi:': { sourceType: 'hudi', fn: 'hudi', kind: 'location' },
  'https:': { sourceType: 'http', fn: 'url', kind: 'location' },
  'http:': { sourceType: 'http', fn: 'url', kind: 'location' },
  'file:': { sourceType: 'file', fn: 'file', kind: 'location' },
}

/** A resolved source: enough to build a table-function read for any table/location. */
export interface SourcePlan {
  readonly scheme: string
  readonly sourceType: string
  readonly kind: SourceKind
  readonly fn: string
  /**
   * Table-function expression for a named table/collection (server sources) or
   * the configured location (object-storage / URL / file sources, where the
   * name is unused). Throws if a server source is given no name.
   */
  table(name?: string): Expr
  /**
   * Table-function expression aimed at an explicit catalog table on a
   * ClickHouse server source — used by metadata discovery. Throws for any other
   * source family.
   */
  serverTable(database: string, table: string): Expr
}

const bound = (value: unknown, chType = 'String'): Expr => ({ kind: 'Value', value, chType })
const call = (name: string, args: Expr[]): Expr => ({ kind: 'Function', name, args })

const decode = (raw: string): string | undefined =>
  raw === '' ? undefined : decodeURIComponent(raw)

/** Split a `qualifier.object` name into its parts (a bare name has no qualifier). */
function splitName(name: string): [string | undefined, string] {
  const dot = name.indexOf('.')
  return dot === -1 ? [undefined, name] : [name.slice(0, dot), name.slice(dot + 1)]
}

/** Resolve a connection config into a reusable source plan. */
export function buildSource(config: ConnectConfig): SourcePlan {
  if (config === null || typeof config !== 'object' || typeof config.url !== 'string' || config.url === '') {
    throw new ChdbCompileError('connect(config) requires a non-empty url')
  }

  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new ChdbCompileError(`Invalid connect url ${JSON.stringify(config.url)}`)
  }

  const resolved = SCHEMES[url.protocol]
  if (resolved === undefined) {
    throw new ChdbCompileError(`Unsupported connect url scheme ${JSON.stringify(url.protocol.replace(/:$/, ''))}`)
  }
  const spec: SchemeSpec = resolved

  // A ClickHouse server reached with `secure: true` uses the TLS table function,
  // matching the always-secure `clickhouse-cloud://` scheme.
  const fn = spec.fn === 'remote' && config.secure === true ? 'remoteSecure' : spec.fn

  const addr = url.host
  const username = config.username ?? decode(url.username)
  const password =
    config.password ?? config.serviceRoleKey ?? config.anonKey ?? decode(url.password)
  const database = config.database ?? decode(url.pathname.replace(/^\//, ''))

  /** Require both credentials (or neither) and append them in order. */
  function requireAuth(): [Expr, Expr] {
    if (username === undefined || password === undefined) {
      throw new ChdbCompileError(`A ${spec.sourceType} source requires a username and password`)
    }
    return [bound(username), bound(password)]
  }

  function remoteArgs(database_: string, table: string): Expr[] {
    const args = [bound(addr), bound(database_), bound(table)]
    if (password !== undefined && username === undefined) {
      throw new ChdbCompileError('A ClickHouse source password requires a username')
    }
    if (username !== undefined) {
      args.push(bound(username))
      if (password !== undefined) args.push(bound(password))
    }
    return args
  }

  function locationArgs(): Expr[] {
    const location = spec.fn === 'file' ? (decode(url.pathname) ?? '') : config.url
    const args: Expr[] = [bound(location)]

    const hasKey = config.accessKeyId !== undefined
    const hasSecret = config.secretAccessKey !== undefined
    if (hasKey !== hasSecret) {
      throw new ChdbCompileError(`A ${spec.sourceType} source needs both accessKeyId and secretAccessKey, or neither`)
    }
    const credentialed = spec.fn === 's3' || spec.fn === 'gcs' || spec.fn === 'iceberg' || spec.fn === 'deltaLake' || spec.fn === 'hudi'
    if (credentialed && hasKey && hasSecret) {
      args.push(bound(config.accessKeyId))
      args.push(bound(config.secretAccessKey))
    }

    // file/url/s3/gcs/azure accept a trailing format; the lakehouse functions
    // detect it from the table metadata, so it is not passed there.
    const takesFormat = spec.fn === 'file' || spec.fn === 'url' || spec.fn === 's3' || spec.fn === 'gcs' || spec.fn === 'azureBlobStorage'
    if (takesFormat && config.format !== undefined) args.push(bound(config.format))
    return args
  }

  function serverTable(database_: string, table: string): Expr {
    if (spec.sourceType === 'clickhouse') {
      return call(fn, remoteArgs(database_, table))
    }
    throw new ChdbCompileError(`Catalog reads over a ${spec.sourceType} source are not supported`)
  }

  function table(name?: string): Expr {
    if (spec.kind === 'location') return call(spec.fn, locationArgs())

    if (name === undefined) {
      throw new ChdbCompileError(`A ${spec.sourceType} source needs a table name: connection.table('database.table')`)
    }
    const [qualifier, object] = splitName(name)

    switch (spec.fn) {
      case 'remote':
      case 'remoteSecure': {
        const db = qualifier ?? database
        if (db === undefined) {
          throw new ChdbCompileError("A ClickHouse source needs a database: pass connect({ database }) or table('database.table')")
        }
        return call(fn, remoteArgs(db, object))
      }
      case 'postgresql': {
        if (database === undefined) {
          throw new ChdbCompileError('A Postgres source needs a database: pass connect({ database }) or set it in the url')
        }
        const [user, pass] = requireAuth()
        const args = [bound(addr), bound(database), bound(object), user, pass]
        const schema = qualifier ?? config.schema
        if (schema !== undefined) args.push(bound(schema))
        return call('postgresql', args)
      }
      case 'mysql': {
        const db = qualifier ?? database
        if (db === undefined) {
          throw new ChdbCompileError('A MySQL source needs a database: pass connect({ database }) or table(\'database.table\')')
        }
        const [user, pass] = requireAuth()
        return call('mysql', [bound(addr), bound(db), bound(object), user, pass])
      }
      case 'mongodb': {
        const db = qualifier ?? database
        if (db === undefined) {
          throw new ChdbCompileError('A MongoDB source needs a database: pass connect({ database }) or table(\'database.collection\')')
        }
        const [user, pass] = requireAuth()
        return call('mongodb', [bound(addr), bound(db), bound(object), user, pass])
      }
      default:
        throw new ChdbCompileError(`Unsupported server source ${spec.sourceType}`)
    }
  }

  return {
    scheme: url.protocol.replace(/:$/, ''),
    sourceType: spec.sourceType,
    kind: spec.kind,
    fn,
    table,
    serverTable,
  }
}
