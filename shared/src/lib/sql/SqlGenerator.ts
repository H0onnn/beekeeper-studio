import { Dialect, KnexDialect, Schema, SchemaItem } from '../dialects/models'
import {Knex} from 'knex'
import knexlib from 'knex'
import { BigQueryClient } from '../knex-bigquery'
import knexFirebirdDialect from "knex-firebird-dialect"
import { identify } from 'sql-query-identifier'

interface GeneratorConnection {
  dbConfig: any
  dbName: string
}

export class SqlGenerator {
  private _dialect: Dialect
  private _connection: GeneratorConnection
  private knex: Knex
  private isNativeKnex: boolean;

  constructor(dialect: Dialect, connection: GeneratorConnection) {
    this.connection = connection
    this.dialect = dialect
    this.createKnexLib()
  }

  public get dialect() : Dialect {
    return this._dialect
  }

  public set dialect(v : Dialect) {
    this._dialect = v;
    this.isNativeKnex = !['cassandra', 'bigquery', 'firebird'].includes(v)
    this.createKnexLib()
  }

  public get connection() {
    return this._connection
  }

  public set connection(config: any) {
    this._connection = config
    this.createKnexLib()
  }


  public buildSql(schema: Schema): string {
    let k
    if (this.isNativeKnex) {
      k = schema.schema ? this.knex.schema.withSchema(schema.schema) : this.knex.schema
    } else {
      k = this.knex.schema.withSchema(schema.schema ? schema.schema : this._connection.dbName)
    }

    let sql = k.createTable(schema.name, (table) => {

      const primaries = schema.columns.filter(c => this.getPrimaries(c))
      if (primaries.length > 0) {
        table.primary(primaries.map((c) => c.columnName))
      }
      schema.columns.forEach((column: SchemaItem) => {
        // TODO: autoincrement makes cassandra just roll over and die Need to remove it from the default values.
        // Other than that, was creating tables pretty ok I think
        const col = column.dataType === 'autoincrement' ?
          table.increments(column.columnName) :
          table.specificType(column.columnName, column.dataType)

        if (column.defaultValue) col.defaultTo(this.knex.raw(column.defaultValue))
        if (column.unsigned) col.unsigned()
        if (column.comment) col.comment(column.comment)
        column.nullable ? col.nullable() : col.notNullable()
      })
    }).toQuery()

    // HACK: firebird knex includes the database path in the query which breaks
    // the sql syntax
    if (this.dialect === 'firebird') {
      const queries = identify(sql, { strict: false, dialect: "generic" })
      sql = queries.reduce((prev, curr) => prev + curr.text.replace(`${this.connection.dbName}.`, ''), '')
    }

    return sql
  }


// Private below here plz

  private getPrimaries(c): boolean {
    if (this.isNativeKnex) {
      return c.primaryKey && c.dataType !== 'autoincrement'
    }

    return c.primaryKey
  }

  private async createKnexLib () {
    const { dbConfig, dbName } = this.connection
    if (!this.dialect || !this.connection) return

    if (this.isNativeKnex) {
        this.knex = knexlib({ client: this.knexDialect })
    } else if (this.dialect === 'firebird') {
        this.knex = knexlib({
          client: knexFirebirdDialect,
          connection: {
            host: dbConfig.host,
            port: dbConfig.port,
            database: dbName,
            user: dbConfig.user,
            password: dbConfig.password,
            // eslint-disable-next-line
            // @ts-ignore
            blobAsText: true,
          },
        })
    } else if (this.dialect === 'bigquery') {
      const apiEndpoint = dbConfig.host !== "" && dbConfig.port !== "" ? `http://${dbConfig.host}:${dbConfig.port}` : undefined;
      this.knex = knexlib({
        // ewwwwwwwww
        client: BigQueryClient as any,
        connection: {
          projectId: dbConfig.bigQueryOptions?.projectId,
          keyFilename: dbConfig.bigQueryOptions?.keyFilename,
          // for testing
          apiEndpoint
        } as any
      })
    }
  }

  private get knexDialect() {
    return KnexDialect(this.dialect)
  }


}
