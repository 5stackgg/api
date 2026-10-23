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

const INHERITED_ROLES = join(
  process.cwd(),
  "hasura",
  "metadata",
  "inherited_roles.yaml",
);

// The SQL specs run without a Hasura engine, so a table permission is compiled
// here from its metadata into the WHERE clause Hasura would add to the
// statement. Supports _and / _or / _not, the _eq / _neq / _in / _nin /
// _is_null operators, X-Hasura-* session values, foreign-key and manual
// relationships and computed fields that take the session; anything else
// throws.
//
// A role with no permission of its own on a table answers with the roles
// inherited_roles.yaml builds it from, their filters ORed and their grants
// unioned. Hasura also nulls a column on rows only a parent without that
// column admits; every role set here has a single parent, so that never arises.
export class HasuraPermissions {
  private readonly tables = new Map<string, Record<string, any>>();
  private readonly foreignKeys = new Map<
    string,
    { table: string; column: string }
  >();
  private aliases = 0;
  private inherited?: Array<{ role_name: string; role_set: string[] }>;

  constructor(private readonly postgres: PostgresService) {}

  async where(
    table: string,
    operation: "select" | "update" | "delete",
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): Promise<string> {
    const blocks = this.blocks(table, operation, session.role);

    if (blocks.length === 0) {
      throw new Error(
        `${table} has no ${operation} permission for ${session.role}`,
      );
    }

    const filters: Array<string> = [];

    for (const block of blocks) {
      filters.push(
        await this.compile(
          block.permission.filter,
          table,
          alias,
          session,
          params,
        ),
      );
    }

    return filters.length === 1 ? filters[0] : `(${filters.join(" OR ")})`;
  }

  // A select the way the engine runs it for the role: the fields asked for and
  // the caller's own where may only name columns and computed fields the role
  // is granted, and the role's filter is ANDed on.
  async select(
    table: string,
    alias: string,
    session: PermissionSession,
    query: { fields: Array<string>; where?: BoolExp },
    params: Array<unknown>,
  ): Promise<string> {
    const granted = this.granted(table, session.role);

    for (const field of [...query.fields, ...this.named(query.where ?? {})]) {
      if (!granted.includes(field)) {
        throw new Error(`field '${field}' not found in type: '${table}'`);
      }
    }

    const fields = query.fields.map(
      (field) =>
        `${this.reference(field, table, alias, session, params)} AS "${field}"`,
    );
    const filter = await this.where(table, "select", alias, session, params);
    const where = await this.compile(
      query.where ?? {},
      table,
      alias,
      session,
      params,
    );

    return `SELECT ${fields.join(", ")} FROM public."${table}" ${alias} WHERE ${filter} AND ${where}`;
  }

  granted(table: string, role: string): Array<string> {
    const granted = new Set<string>();

    for (const block of this.blocks(table, "select", role)) {
      if (!Array.isArray(block.permission.columns)) {
        throw new Error(`unsupported columns ${block.permission.columns}`);
      }

      for (const field of [
        ...block.permission.columns,
        ...(block.permission.computed_fields ?? []),
      ]) {
        granted.add(field);
      }
    }

    return [...granted];
  }

  private blocks(
    table: string,
    operation: "select" | "update" | "delete",
    role: string,
  ): Array<Record<string, any>> {
    const own = (this.metadata(table)[`${operation}_permissions`] ?? []).find(
      (entry: { role: string }) => entry.role === role,
    );

    if (own) {
      return [own];
    }

    const inherited = this.inheritedRoles().find(
      (entry) => entry.role_name === role,
    );

    return (inherited?.role_set ?? []).flatMap((parent) =>
      this.blocks(table, operation, parent),
    );
  }

  private inheritedRoles(): Array<{ role_name: string; role_set: string[] }> {
    if (!this.inherited) {
      this.inherited = yaml.load(
        readFileSync(INHERITED_ROLES, "utf8"),
      ) as Array<{ role_name: string; role_set: string[] }>;
    }
    return this.inherited;
  }

  private named(expression: BoolExp): Array<string> {
    return Object.entries(expression).flatMap(([key, value]) => {
      if (key === "_and" || key === "_or") {
        return (value as Array<BoolExp>).flatMap((part) => this.named(part));
      }
      if (key === "_not") {
        return this.named(value);
      }
      return [key];
    });
  }

  private reference(
    field: string,
    table: string,
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): string {
    const computed = (this.metadata(table).computed_fields ?? []).find(
      (entry: { name: string }) => entry.name === field,
    );

    if (!computed) {
      return `${alias}."${field}"`;
    }

    return this.computedCall(computed, alias, session, params);
  }

  private computedCall(
    computed: Record<string, any>,
    alias: string,
    session: PermissionSession,
    params: Array<unknown>,
  ): string {
    if (!computed.definition.session_argument) {
      return `public."${computed.definition.function.name}"(${alias})`;
    }

    params.push(
      JSON.stringify({
        "x-hasura-role": session.role,
        "x-hasura-user-id": session.userId,
      }),
    );

    return `public."${computed.definition.function.name}"(${alias}, $${params.length}::json)`;
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
      const manual = relationship.using.manual_configuration;
      const remoteAlias = `${alias}_${++this.aliases}`;
      let remoteTable: string;
      let join: string;

      if (manual) {
        remoteTable = manual.remote_table.name;
        join = Object.entries(manual.column_mapping as Record<string, string>)
          .map(
            ([local, remote]) =>
              `${remoteAlias}."${remote}" = ${alias}."${local}"`,
          )
          .join(" AND ");
      } else if (typeof using === "string") {
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
      return this.operators(
        this.computedCall(computed, alias, session, params),
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
