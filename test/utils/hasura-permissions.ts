import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { PostgresService } from "../../src/postgres/postgres.service";

type BoolExp = Record<string, any>;

export type PermissionSession = { role: string; userId: string };

const TABLES = join(
  process.cwd(),
  "hasura",
  "metadata",
  "databases",
  "default",
  "tables",
);

// The SQL specs run without a Hasura engine, so a table permission is compiled
// here from its metadata into the WHERE clause Hasura would add to the
// statement. Supports _and / _or / _not, the _eq / _neq / _in / _nin /
// _is_null operators, X-Hasura-* session values, foreign-key relationships and
// computed fields that take the session; anything else throws.
export class HasuraPermissions {
  private readonly tables = new Map<string, Record<string, any>>();
  private readonly foreignKeys = new Map<
    string,
    { table: string; column: string }
  >();
  private aliases = 0;

  constructor(private readonly postgres: PostgresService) {}

  async where(
    table: string,
    operation: "select" | "update" | "delete",
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): Promise<string> {
    const block = (this.metadata(table)[`${operation}_permissions`] ?? []).find(
      (entry: { role: string }) => entry.role === session.role,
    );

    if (!block) {
      throw new Error(
        `${table} has no ${operation} permission for ${session.role}`,
      );
    }

    return this.compile(block.permission.filter, table, alias, session, params);
  }

  private metadata(table: string): Record<string, any> {
    if (!this.tables.has(table)) {
      this.tables.set(
        table,
        yaml.load(
          readFileSync(join(TABLES, `public_${table}.yaml`), "utf8"),
        ) as Record<string, any>,
      );
    }
    return this.tables.get(table)!;
  }

  private async compile(
    expression: BoolExp,
    table: string,
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): Promise<string> {
    const clauses: Array<string> = [];

    for (const [key, value] of Object.entries(expression)) {
      if (key === "_and" || key === "_or") {
        const parts: Array<string> = [];
        for (const part of value as Array<BoolExp>) {
          parts.push(await this.compile(part, table, alias, session, params));
        }
        clauses.push(
          parts.length
            ? `(${parts.join(key === "_and" ? " AND " : " OR ")})`
            : String(key === "_and"),
        );
      } else if (key === "_not") {
        clauses.push(
          `NOT (${await this.compile(value, table, alias, session, params)})`,
        );
      } else {
        clauses.push(
          await this.field(key, value, table, alias, session, params),
        );
      }
    }

    return clauses.length ? `(${clauses.join(" AND ")})` : "true";
  }

  private async field(
    name: string,
    value: BoolExp,
    table: string,
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): Promise<string> {
    const metadata = this.metadata(table);
    const relationship = [
      ...(metadata.object_relationships ?? []),
      ...(metadata.array_relationships ?? []),
    ].find((entry: { name: string }) => entry.name === name);

    if (relationship) {
      const using = relationship.using.foreign_key_constraint_on;
      const remoteAlias = `${alias}_${++this.aliases}`;
      let remoteTable: string;
      let join: string;

      if (typeof using === "string") {
        const target = await this.references(table, using);
        remoteTable = target.table;
        join = `${remoteAlias}."${target.column}" = ${alias}."${using}"`;
      } else {
        const target = await this.references(using.table.name, using.column);
        remoteTable = using.table.name;
        join = `${remoteAlias}."${using.column}" = ${alias}."${target.column}"`;
      }

      const inner = await this.compile(
        value,
        remoteTable,
        remoteAlias,
        session,
        params,
      );
      return `EXISTS (SELECT 1 FROM public."${remoteTable}" ${remoteAlias} WHERE ${join} AND ${inner})`;
    }

    const computed = (metadata.computed_fields ?? []).find(
      (entry: { name: string }) => entry.name === name,
    );

    if (computed) {
      const fn = computed.definition.function.name;
      params.push(
        JSON.stringify({
          "x-hasura-role": session.role,
          "x-hasura-user-id": session.userId,
        }),
      );
      const sessionArgument = computed.definition.session_argument
        ? `, $${params.length}::json`
        : "";
      return this.operators(
        `public."${fn}"(${alias}${sessionArgument})`,
        value,
        session,
        params,
      );
    }

    return this.operators(`${alias}."${name}"`, value, session, params);
  }

  private operators(
    target: string,
    operators: BoolExp,
    session: PermissionSession,
    params: Array<unknown>,
  ): string {
    const bind = (raw: unknown) => {
      params.push(this.sessionValue(raw, session));
      return `$${params.length}`;
    };

    return `(${Object.entries(operators)
      .map(([operator, raw]) => {
        switch (operator) {
          case "_eq":
            return `${target} = ${bind(raw)}`;
          case "_neq":
            return `${target} <> ${bind(raw)}`;
          case "_in":
            return `${target} = ANY(${bind(raw)})`;
          case "_nin":
            return `NOT (${target} = ANY(${bind(raw)}))`;
          case "_is_null":
            return raw ? `${target} IS NULL` : `${target} IS NOT NULL`;
          default:
            throw new Error(`unsupported operator ${operator}`);
        }
      })
      .join(" AND ")})`;
  }

  private sessionValue(raw: unknown, session: PermissionSession): unknown {
    if (typeof raw !== "string") {
      return raw;
    }
    switch (raw.toLowerCase()) {
      case "x-hasura-user-id":
        return session.userId;
      case "x-hasura-role":
        return session.role;
      default:
        return raw;
    }
  }

  private async references(
    table: string,
    column: string,
  ): Promise<{ table: string; column: string }> {
    const key = `${table}.${column}`;

    if (!this.foreignKeys.has(key)) {
      const [target] = await this.postgres.query<
        Array<{ table: string; column: string }>
      >(
        `SELECT target.relname AS table, target_column.attname AS column
           FROM pg_constraint c
           JOIN pg_class source ON source.oid = c.conrelid
           JOIN pg_namespace ns ON ns.oid = source.relnamespace
           JOIN pg_attribute source_column
             ON source_column.attrelid = c.conrelid AND source_column.attnum = c.conkey[1]
           JOIN pg_class target ON target.oid = c.confrelid
           JOIN pg_attribute target_column
             ON target_column.attrelid = c.confrelid AND target_column.attnum = c.confkey[1]
          WHERE c.contype = 'f'
            AND ns.nspname = 'public'
            AND source.relname = $1
            AND source_column.attname = $2`,
        [table, column],
      );

      if (!target) {
        throw new Error(`no foreign key on ${key}`);
      }

      this.foreignKeys.set(key, target);
    }

    return this.foreignKeys.get(key)!;
  }
}
