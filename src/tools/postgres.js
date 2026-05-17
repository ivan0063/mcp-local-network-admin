import pg from 'pg';

const { Pool } = pg;

/**
 * PostgreSQL Client
 * Gestiona múltiples conexiones nombradas en memoria.
 * Las credenciales nunca se persisten en disco — solo viven mientras el server corre.
 *
 * Conexión: postgresql://usuario:contraseña@host:5432/base_de_datos
 */
export class PostgresClient {
  constructor() {
    // name → { pool, connectionString (sin password para mostrar) }
    this.connections = new Map();
  }

  // ─── Conexiones ───────────────────────────────────────────────

  async connect(name, connectionString) {
    if (this.connections.has(name)) {
      await this.connections.get(name).pool.end();
    }
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
    // Verificar que la conexión funciona
    const client = await pool.connect();
    const { rows } = await client.query('SELECT current_database(), current_user, version()');
    client.release();
    const safe = connectionString.replace(/:([^:@]+)@/, ':***@');
    this.connections.set(name, { pool, safe });
    return {
      success: true,
      connection: name,
      database: rows[0].current_database,
      user: rows[0].current_user,
      version: rows[0].version.split(' ').slice(0, 2).join(' '),
    };
  }

  async disconnect(name) {
    const entry = this._get(name);
    await entry.pool.end();
    this.connections.delete(name);
    return { success: true, message: `Conexión '${name}' cerrada` };
  }

  listConnections() {
    return [...this.connections.entries()].map(([name, { safe }]) => ({ name, url: safe }));
  }

  _get(name) {
    const entry = this.connections.get(name);
    if (!entry) throw new Error(`Conexión '${name}' no encontrada. Usa pg_connect primero.`);
    return entry;
  }

  async query(name, sql, params = []) {
    const { pool } = this._get(name);
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  // ─── Exploración ──────────────────────────────────────────────

  async listDatabases(name) {
    return this.query(name, `
      SELECT datname AS database,
             pg_size_pretty(pg_database_size(datname)) AS size,
             datcollate AS collation,
             datctype AS ctype
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `);
  }

  async listSchemas(name) {
    return this.query(name, `
      SELECT schema_name,
             schema_owner
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY schema_name
    `);
  }

  async listTables(name, schema = 'public') {
    return this.query(name, `
      SELECT t.table_name,
             t.table_type,
             pg_size_pretty(pg_total_relation_size('"' || t.table_schema || '"."' || t.table_name || '"')) AS total_size,
             pg_size_pretty(pg_relation_size('"' || t.table_schema || '"."' || t.table_name || '"')) AS data_size,
             c.reltuples::bigint AS estimated_rows
      FROM information_schema.tables t
      JOIN pg_class c ON c.relname = t.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
      WHERE t.table_schema = $1
      ORDER BY t.table_name
    `, [schema]);
  }

  async describeTable(name, table, schema = 'public') {
    const columns = await this.query(name, `
      SELECT c.column_name,
             c.data_type,
             c.character_maximum_length,
             c.numeric_precision,
             c.numeric_scale,
             c.is_nullable,
             c.column_default,
             CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key,
             CASE WHEN uq.column_name IS NOT NULL THEN true ELSE false END AS is_unique
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = $1 AND tc.table_schema = $2
      ) pk ON pk.column_name = c.column_name
      LEFT JOIN (
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE'
          AND tc.table_name = $1 AND tc.table_schema = $2
      ) uq ON uq.column_name = c.column_name
      WHERE c.table_name = $1 AND c.table_schema = $2
      ORDER BY c.ordinal_position
    `, [table, schema]);

    const foreignKeys = await this.query(name, `
      SELECT kcu.column_name,
             ccu.table_name AS foreign_table,
             ccu.column_name AS foreign_column,
             rc.update_rule,
             rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1 AND tc.table_schema = $2
    `, [table, schema]);

    return { table: `${schema}.${table}`, columns, foreign_keys: foreignKeys };
  }

  async listIndexes(name, table, schema = 'public') {
    return this.query(name, `
      SELECT i.relname AS index_name,
             ix.indisunique AS is_unique,
             ix.indisprimary AS is_primary,
             array_agg(a.attname ORDER BY k.n) AS columns,
             am.amname AS index_type,
             pg_size_pretty(pg_relation_size(i.oid)) AS size
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_am am ON i.relam = am.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = $1 AND n.nspname = $2
      GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname, i.oid
      ORDER BY ix.indisprimary DESC, i.relname
    `, [table, schema]);
  }

  async listViews(name, schema = 'public') {
    return this.query(name, `
      SELECT table_name AS view_name,
             view_definition
      FROM information_schema.views
      WHERE table_schema = $1
      ORDER BY table_name
    `, [schema]);
  }

  async listFunctions(name, schema = 'public') {
    return this.query(name, `
      SELECT routine_name AS function_name,
             routine_type,
             data_type AS return_type,
             external_language AS language
      FROM information_schema.routines
      WHERE specific_schema = $1
      ORDER BY routine_name
    `, [schema]);
  }

  async listUsers(name) {
    return this.query(name, `
      SELECT rolname AS role,
             rolsuper AS is_superuser,
             rolcreatedb AS can_create_db,
             rolcreaterole AS can_create_role,
             rolcanlogin AS can_login,
             rolconnlimit AS connection_limit,
             rolvaliduntil AS expires_at
      FROM pg_roles
      ORDER BY rolname
    `);
  }

  // ─── Ejecución de queries ─────────────────────────────────────

  async runQuery(name, sql, limit = 100) {
    const { pool } = this._get(name);
    const safeSql = /^\s*SELECT/i.test(sql.trim())
      ? `SELECT * FROM (${sql}) __q LIMIT ${limit}`
      : sql;
    const result = await pool.query(safeSql);
    return {
      rows: result.rows,
      row_count: result.rowCount,
      fields: result.fields?.map(f => ({ name: f.name, type: f.dataTypeID })),
    };
  }

  async execute(name, sql) {
    const { pool } = this._get(name);
    const result = await pool.query(sql);
    return {
      command: result.command,
      row_count: result.rowCount,
      rows: result.rows ?? [],
    };
  }

  async explain(name, sql) {
    const rows = await this.query(name, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    return rows[0]['QUERY PLAN'];
  }

  // ─── Creación de objetos ──────────────────────────────────────

  async createDatabase(name, dbName, owner = null) {
    const { pool } = this._get(name);
    const ownerClause = owner ? ` OWNER "${owner}"` : '';
    // CREATE DATABASE no puede correr en transacción, usar pool directamente
    const client = await pool.connect();
    try {
      await client.query(`CREATE DATABASE "${dbName}"${ownerClause}`);
    } finally {
      client.release();
    }
    return { success: true, message: `Base de datos '${dbName}' creada` };
  }

  async createSchema(name, schemaName, owner = null) {
    const ownerClause = owner ? ` AUTHORIZATION "${owner}"` : '';
    await this.execute(name, `CREATE SCHEMA IF NOT EXISTS "${schemaName}"${ownerClause}`);
    return { success: true, message: `Schema '${schemaName}' creado` };
  }

  async createTable(name, table, columns, schema = 'public') {
    // columns: [{ name, type, nullable, default, primary_key, unique }]
    const colDefs = columns.map(c => {
      let def = `"${c.name}" ${c.type}`;
      if (c.primary_key) def += ' PRIMARY KEY';
      else if (c.unique) def += ' UNIQUE';
      if (!c.nullable && !c.primary_key) def += ' NOT NULL';
      if (c.default !== undefined && c.default !== null) def += ` DEFAULT ${c.default}`;
      return def;
    }).join(',\n  ');
    const sql = `CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (\n  ${colDefs}\n)`;
    await this.execute(name, sql);
    return { success: true, sql };
  }

  async dropTable(name, table, schema = 'public', cascade = false) {
    const sql = `DROP TABLE IF EXISTS "${schema}"."${table}"${cascade ? ' CASCADE' : ' RESTRICT'}`;
    await this.execute(name, sql);
    return { success: true, sql };
  }

  // ─── Administración ───────────────────────────────────────────

  async runningQueries(name) {
    return this.query(name, `
      SELECT pid,
             now() - query_start AS duration,
             state,
             wait_event_type,
             wait_event,
             left(query, 120) AS query,
             application_name,
             client_addr
      FROM pg_stat_activity
      WHERE state != 'idle' AND pid != pg_backend_pid()
      ORDER BY duration DESC NULLS LAST
    `);
  }

  async killQuery(name, pid) {
    const rows = await this.query(name, 'SELECT pg_terminate_backend($1) AS terminated', [pid]);
    return { pid, terminated: rows[0].terminated };
  }

  async tableStats(name, schema = 'public') {
    return this.query(name, `
      SELECT relname AS table,
             n_live_tup AS live_rows,
             n_dead_tup AS dead_rows,
             n_mod_since_analyze AS modified_since_analyze,
             last_vacuum,
             last_autovacuum,
             last_analyze,
             pg_size_pretty(pg_total_relation_size('"' || schemaname || '"."' || relname || '"')) AS total_size
      FROM pg_stat_user_tables
      WHERE schemaname = $1
      ORDER BY n_live_tup DESC
    `, [schema]);
  }

  async healthCheck(name) {
    const [general] = await this.query(name, `
      SELECT current_database() AS database,
             pg_size_pretty(pg_database_size(current_database())) AS db_size,
             (SELECT count(*) FROM pg_stat_activity) AS total_connections,
             (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
             (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active_queries,
             (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock') AS waiting_on_lock
    `);

    const [cache] = await this.query(name, `
      SELECT round(
        sum(heap_blks_hit) * 100.0 / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2
      ) AS cache_hit_ratio
      FROM pg_statio_user_tables
    `);

    const bloat = await this.query(name, `
      SELECT relname AS table,
             n_dead_tup AS dead_rows,
             n_live_tup AS live_rows,
             round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 1) AS bloat_pct
      FROM pg_stat_user_tables
      WHERE n_dead_tup > 1000
      ORDER BY n_dead_tup DESC
      LIMIT 5
    `);

    return {
      ...general,
      cache_hit_ratio_pct: cache.cache_hit_ratio,
      top_bloated_tables: bloat,
    };
  }

  // ─── Extras ───────────────────────────────────────────────────

  async erDiagram(name, schema = 'public') {
    const tables = await this.listTables(name, schema);
    const fkeys = await this.query(name, `
      SELECT tc.table_name AS from_table,
             kcu.column_name AS from_column,
             ccu.table_name AS to_table,
             ccu.column_name AS to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
    `, [schema]);

    const lines = [`Schema: ${schema}\n${'─'.repeat(40)}`];
    for (const t of tables) {
      lines.push(`\n┌─ ${t.table_name} (${t.estimated_rows ?? '?'} rows, ${t.total_size})`);
    }
    if (fkeys.length > 0) {
      lines.push(`\nRelaciones:`);
      for (const fk of fkeys) {
        lines.push(`  ${fk.from_table}.${fk.from_column} → ${fk.to_table}.${fk.to_column}`);
      }
    }
    return lines.join('\n');
  }

  async dumpSchema(name, schema = 'public') {
    const tables = await this.listTables(name, schema);
    const ddl = [];

    for (const t of tables.filter(t => t.table_type === 'BASE TABLE')) {
      const { columns, foreign_keys } = await this.describeTable(name, t.table_name, schema);
      const cols = columns.map(c => {
        let def = `  "${c.column_name}" ${c.data_type}`;
        if (c.character_maximum_length) def += `(${c.character_maximum_length})`;
        if (c.is_primary_key) def += ' PRIMARY KEY';
        else if (c.is_unique) def += ' UNIQUE';
        if (c.is_nullable === 'NO' && !c.is_primary_key) def += ' NOT NULL';
        if (c.column_default) def += ` DEFAULT ${c.column_default}`;
        return def;
      });
      for (const fk of foreign_keys) {
        cols.push(`  FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table}"("${fk.foreign_column}") ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule}`);
      }
      ddl.push(`CREATE TABLE "${schema}"."${t.table_name}" (\n${cols.join(',\n')}\n);`);
    }

    const views = await this.listViews(name, schema);
    for (const v of views) {
      ddl.push(`CREATE VIEW "${schema}"."${v.view_name}" AS\n${v.view_definition};`);
    }

    return ddl.join('\n\n');
  }

  async suggestIndexes(name, schema = 'public') {
    const seqScans = await this.query(name, `
      SELECT relname AS table,
             seq_scan,
             seq_tup_read,
             idx_scan,
             n_live_tup AS rows,
             pg_size_pretty(pg_relation_size('"' || schemaname || '"."' || relname || '"')) AS size
      FROM pg_stat_user_tables
      WHERE schemaname = $1
        AND seq_scan > 100
        AND (idx_scan IS NULL OR seq_scan > idx_scan * 2)
        AND n_live_tup > 1000
      ORDER BY seq_scan DESC
      LIMIT 10
    `, [schema]);

    const unusedIndexes = await this.query(name, `
      SELECT schemaname,
             relname AS table,
             indexrelname AS index,
             pg_size_pretty(pg_relation_size(indexrelid)) AS size,
             idx_scan AS times_used
      FROM pg_stat_user_indexes
      WHERE schemaname = $1
        AND idx_scan < 10
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c WHERE c.conindid = indexrelid
        )
      ORDER BY pg_relation_size(indexrelid) DESC
      LIMIT 10
    `, [schema]);

    return {
      tables_missing_indexes: seqScans,
      unused_indexes: unusedIndexes,
      recommendations: seqScans.map(t =>
        `CONSIDER: CREATE INDEX ON "${schema}"."${t.table}" (...); -- ${t.seq_scan} seq scans, ${t.rows} rows`
      ),
    };
  }
}
