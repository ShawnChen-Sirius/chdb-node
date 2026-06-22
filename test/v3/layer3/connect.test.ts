import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectFrom, connect, session } from '../../../index.js'
import { buildSource } from '../../../src/layer3/connect/url-scheme'
import { buildSnapshotNode } from '../../../src/layer3/connect/snapshot'
import { compileDatabases, compileTables, compileDescribe } from '../../../src/layer3/connect/connect'
import { compileExpr, compileQuery } from '../../../src/layer3/compiler/compile'

// connect() maps a connection URL to a ClickHouse table function. The scheme
// picks the function; every host, credential, path, and option is BOUND
// ({pN:Type}) — a connection string never appears as a byte in the SQL. The
// golden tests pin each scheme's mapping; the injection tests prove hostile
// values stay in parameters; the execution tests read real local files.

const table = (cfg: Parameters<typeof buildSource>[0], name?: string) =>
  compileExpr(buildSource(cfg).table(name))

describe('connect — server source mapping (table args are bound)', () => {
  it('clickhouse:// → remote(addr, db, table, user, pw)', () => {
    expect(table({ url: 'clickhouse://u:p@h:9000/prod' }, 'events')).toEqual({
      sql: 'remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:9000', p1: 'prod', p2: 'events', p3: 'u', p4: 'p' },
    })
  })

  it('clickhouse:// with secure → remoteSecure', () => {
    const c = table({ url: 'clickhouse://h:9440', database: 'prod', secure: true }, 'events')
    expect(c.sql).toBe('remoteSecure({p0:String}, {p1:String}, {p2:String})')
    expect(c.parameters).toEqual({ p0: 'h:9440', p1: 'prod', p2: 'events' })
  })

  it('clickhouse-cloud:// → remoteSecure', () => {
    const c = table(
      { url: 'clickhouse-cloud://x.clickhouse.cloud:9440', username: 'default', password: 'pw', database: 'prod' },
      'prod.users',
    )
    expect(c.sql).toBe('remoteSecure({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})')
    // A dotted table name overrides the default database.
    expect(c.parameters).toEqual({ p0: 'x.clickhouse.cloud:9440', p1: 'prod', p2: 'users', p3: 'default', p4: 'pw' })
  })

  it('postgres:// → postgresql(addr, db, table, user, pw)', () => {
    expect(table({ url: 'postgres://u:p@h:5432/app' }, 'users')).toEqual({
      sql: 'postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p' },
    })
  })

  it('postgres:// with a dotted name adds the schema arg', () => {
    const c = table({ url: 'postgres://u:p@h:5432/app' }, 'reporting.users')
    expect(c.sql).toBe('postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String})')
    expect(c.parameters).toEqual({ p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p', p5: 'reporting' })
  })

  it('supabase:// uses the service-role key as the password', () => {
    const c = table(
      { url: 'supabase://abc.supabase.co', database: 'postgres', username: 'postgres', serviceRoleKey: 'srk', schema: 'public' },
      'billing',
    )
    expect(c.sql).toBe('postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}, {p5:String})')
    expect(c.parameters).toEqual({ p0: 'abc.supabase.co', p1: 'postgres', p2: 'billing', p3: 'postgres', p4: 'srk', p5: 'public' })
  })

  it('mysql:// → mysql(addr, db, table, user, pw)', () => {
    expect(table({ url: 'mysql://u:p@h:3306/shop' }, 'orders')).toEqual({
      sql: 'mysql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:3306', p1: 'shop', p2: 'orders', p3: 'u', p4: 'p' },
    })
  })

  it('mongodb:// and mongodb+srv:// → mongodb(addr, db, collection, user, pw)', () => {
    expect(table({ url: 'mongodb://u:p@h:27017/app' }, 'events').sql).toBe(
      'mongodb({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
    )
    expect(table({ url: 'mongodb+srv://u:p@cluster.net/app' }, 'events').parameters).toEqual({
      p0: 'cluster.net',
      p1: 'app',
      p2: 'events',
      p3: 'u',
      p4: 'p',
    })
  })
})

describe('connect — location source mapping', () => {
  it('s3:// → s3(url[, key, secret][, format]); name is ignored', () => {
    expect(table({ url: 's3://b/*.parquet', format: 'Parquet' })).toEqual({
      sql: 's3({p0:String}, {p1:String})',
      parameters: { p0: 's3://b/*.parquet', p1: 'Parquet' },
    })
    const withCreds = table({ url: 's3://b/x', accessKeyId: 'AK', secretAccessKey: 'SK', format: 'CSV' })
    expect(withCreds.sql).toBe('s3({p0:String}, {p1:String}, {p2:String}, {p3:String})')
    expect(withCreds.parameters).toEqual({ p0: 's3://b/x', p1: 'AK', p2: 'SK', p3: 'CSV' })
  })

  it('gcs:// and gs:// → gcs(url, ...)', () => {
    expect(table({ url: 'gcs://b/a.csv', format: 'CSV' }).sql).toBe('gcs({p0:String}, {p1:String})')
    expect(table({ url: 'gs://b/a.csv' }).sql).toBe('gcs({p0:String})')
  })

  it('azureblob:// → azureBlobStorage(url[, format])', () => {
    expect(table({ url: 'azureblob://acct/container/blob', format: 'Parquet' })).toEqual({
      sql: 'azureBlobStorage({p0:String}, {p1:String})',
      parameters: { p0: 'azureblob://acct/container/blob', p1: 'Parquet' },
    })
  })

  it('iceberg://, delta://, hudi:// → lakehouse functions (no format arg)', () => {
    expect(table({ url: 'iceberg://b/t' }).sql).toBe('iceberg({p0:String})')
    expect(table({ url: 'delta://b/t', accessKeyId: 'AK', secretAccessKey: 'SK' }).sql).toBe(
      'deltaLake({p0:String}, {p1:String}, {p2:String})',
    )
    expect(table({ url: 'hudi://b/t' }).sql).toBe('hudi({p0:String})')
  })

  it('http(s):// → url(url[, format])', () => {
    expect(table({ url: 'https://e.com/d.csv', format: 'CSV' })).toEqual({
      sql: 'url({p0:String}, {p1:String})',
      parameters: { p0: 'https://e.com/d.csv', p1: 'CSV' },
    })
  })

  it('file:// → file(path[, format]); the path is the decoded url path', () => {
    expect(table({ url: 'file:///data/x.csv', format: 'CSV' })).toEqual({
      sql: 'file({p0:String}, {p1:String})',
      parameters: { p0: '/data/x.csv', p1: 'CSV' },
    })
  })
})

describe('connect — input validation', () => {
  it('rejects a missing or unsupported url', () => {
    expect(() => buildSource({ url: '' } as any)).toThrow(/requires a non-empty url/)
    expect(() => buildSource({ url: 'redis://h/0' })).toThrow(/Unsupported connect url scheme/)
  })

  it('requires a username and password for postgres/mysql/mongodb', () => {
    expect(() => buildSource({ url: 'postgres://h:5432/app' }).table('users')).toThrow(/username and password/)
    expect(() => buildSource({ url: 'mysql://h:3306/d' }).table('orders')).toThrow(/username and password/)
  })

  it('requires a table name for a server source', () => {
    expect(() => buildSource({ url: 'clickhouse://h:9000/db' }).table()).toThrow(/needs a table name/)
  })

  it('requires both object-storage credentials or neither', () => {
    expect(() => buildSource({ url: 's3://b/x', accessKeyId: 'AK' }).table()).toThrow(/both accessKeyId and secretAccessKey/)
  })
})

describe('connect — injection (urls, credentials, names are bound)', () => {
  const HOSTILE = "'; DROP TABLE users; --"

  it('keeps a hostile password out of the SQL', () => {
    const c = table({ url: 'postgres://h:5432/app', username: 'u', password: HOSTILE }, 'users')
    expect(c.sql).not.toContain('DROP')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })

  it('keeps a hostile table name out of the SQL (it is a bound table-function arg)', () => {
    const c = table({ url: 'clickhouse://u:p@h:9000/db' }, HOSTILE)
    expect(c.sql).toBe('remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })

  it('keeps a hostile url out of the SQL', () => {
    const c = table({ url: `s3://b/x`, accessKeyId: HOSTILE, secretAccessKey: HOSTILE })
    expect(c.sql).not.toContain('DROP')
    expect(Object.values(c.parameters)).toContain(HOSTILE)
  })
})

describe('connect — snapshot (INSERT … SELECT)', () => {
  it('materializes a source table into a local destination', () => {
    const plan = buildSource({ url: 'postgres://u:p@h:5432/app' })
    const compiled = compileQuery(buildSnapshotNode(plan, 'users', 'users_local'))
    expect(compiled).toEqual({
      sql: 'INSERT INTO `users_local` SELECT * FROM postgresql({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String})',
      parameters: { p0: 'h:5432', p1: 'app', p2: 'users', p3: 'u', p4: 'p' },
    })
  })

  it('quote-escapes a dotted / hostile destination identifier', () => {
    const plan = buildSource({ url: 's3://b/x', format: 'Parquet' })
    const compiled = compileQuery(buildSnapshotNode(plan, '', 'db.events`local'))
    expect(compiled.sql).toBe('INSERT INTO `db`.`events\\`local` SELECT * FROM s3({p0:String}, {p1:String})')
  })
})

describe('connect — metadata discovery SQL', () => {
  it('databases() reads system.databases over a ClickHouse source', () => {
    const c = compileDatabases(buildSource({ url: 'clickhouse://u:p@h:9000' }))
    expect(c.sql).toBe(
      'SELECT `name` FROM remote({p0:String}, {p1:String}, {p2:String}, {p3:String}, {p4:String}) ORDER BY `name` ASC',
    )
    expect(c.parameters).toEqual({ p0: 'h:9000', p1: 'system', p2: 'databases', p3: 'u', p4: 'p' })
  })

  it('tables(db) filters system.tables by a bound database name', () => {
    const c = compileTables(buildSource({ url: 'clickhouse://h:9000' }), 'prod')
    expect(c.sql).toBe(
      'SELECT `name` FROM remote({p0:String}, {p1:String}, {p2:String}) WHERE `database` = {p3:String} ORDER BY `name` ASC',
    )
    expect(c.parameters).toEqual({ p0: 'h:9000', p1: 'system', p2: 'tables', p3: 'prod' })
  })

  it('describe() compiles DESCRIBE TABLE over any source', () => {
    const c = compileDescribe(buildSource({ url: 'file:///d/x.csv', format: 'CSV' }))
    expect(c).toEqual({
      sql: 'DESCRIBE TABLE file({p0:String}, {p1:String})',
      parameters: { p0: '/d/x.csv', p1: 'CSV' },
    })
  })

  it('databases()/tables() reject non-ClickHouse sources', () => {
    expect(() => compileDatabases(buildSource({ url: 'postgres://u:p@h/app' }))).toThrow(/only available for ClickHouse/)
  })
})

describe('connect — execution against real local files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l3-connect-'))
  const users = join(dir, 'users.csv')
  const events = join(dir, 'events.csv')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  beforeEach(() => {
    writeFileSync(users, 'id,country\n1,US\n2,FR\n3,US\n')
    writeFileSync(events, 'uid,action\n1,login\n1,buy\n3,login\n')
  })

  it('reads rows through a file:// connection', async () => {
    const conn = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const rows = (await selectFrom(conn.table().as('u'))
      .select('country')
      .where('country', '=', 'US')
      .orderBy('country')
      .execute()) as { country: string }[]
    expect(rows).toEqual([{ country: 'US' }, { country: 'US' }])
  })

  it('describe() returns the inferred columns', async () => {
    const conn = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const cols = await conn.describe()
    expect(cols.map((c) => c.name)).toContain('country')
  })

  it('joins two file:// connections (cross-source JOIN)', async () => {
    const u = connect({ url: `file://${users}`, format: 'CSVWithNames' })
    const e = connect({ url: `file://${events}`, format: 'CSVWithNames' })
    const rows = (await selectFrom(u.table().as('u'))
      .innerJoin(e.table().as('e'), 'u.id', 'e.uid')
      .select(['u.country', 'e.action'])
      .orderBy('e.action')
      .execute()) as { country: string; action: string }[]
    expect(rows).toEqual([
      { country: 'US', action: 'buy' },
      { country: 'US', action: 'login' },
      { country: 'US', action: 'login' },
    ])
  })

  it('snapshot() materializes a file source into a local table', async () => {
    const db = session()
    try {
      await db.session!.queryAsync('CREATE TABLE snap (id Int64, country String) ENGINE = Memory')
      const conn = db.connect({ url: `file://${users}`, format: 'CSVWithNames' })
      await conn.snapshot('', { destination: 'snap' })
      const rows = (await db.selectFrom('snap').select('country').orderBy('id').execute()) as {
        country: string
      }[]
      expect(rows).toEqual([{ country: 'US' }, { country: 'FR' }, { country: 'US' }])
    } finally {
      db.close()
    }
  })
})
