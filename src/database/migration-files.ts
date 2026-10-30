import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { env } from '../config/env.js';

/**
 * Pasta das migrations compiladas, lida pelos scripts `migrate-*` (em `dist/`).
 */
export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

/**
 * Pasta dos fontes das migrations, escrita pelo `migration-generate` (a partir da raiz do projeto).
 */
export const SOURCE_MIGRATIONS_DIR = resolve(
  process.cwd(),
  'src',
  'database',
  'migrations',
);

/**
 * Caminho do snapshot do schema, mantido junto aos fontes das migrations.
 */
export const SNAPSHOT_PATH = join(SOURCE_MIGRATIONS_DIR, 'snapshot.json');

/**
 * Instância do Drizzle recebida pelos métodos `up` e `down` de cada migration.
 */
export type Database = MySql2Database;

/**
 * Snapshot do schema no formato JSON do drizzle-kit (os tipos dele resolvem para `any`).
 */
export type Snapshot = Record<string, unknown>;

/**
 * Contrato de um arquivo de migration: um único módulo com os métodos `up` e `down`.
 */
export interface Migration {
  /**
   * Aplica a migration.
   *
   * @param db - Instância do Drizzle conectada ao banco.
   * @returns Promise resolvida quando as alterações forem aplicadas.
   */
  up(db: Database): Promise<void>;

  /**
   * Reverte a migration.
   *
   * @param db - Instância do Drizzle conectada ao banco.
   * @returns Promise resolvida quando as alterações forem revertidas.
   */
  down(db: Database): Promise<void>;
}

/**
 * Registro de uma migration já aplicada ao banco.
 */
export interface AppliedMigration {
  id: number;
  name: string;
}

/**
 * Conexão standalone usada pelos scripts de migration, sem subir o Nest.
 */
export interface MigrationConnection {
  pool: Pool;
  db: Database;
}

/**
 * Abre um pool `mysql2` próprio e a instância do Drizzle para os scripts de migration.
 *
 * @returns Pool e instância do Drizzle; o chamador deve encerrar o pool com `pool.end()`.
 * @throws Erro do driver se os parâmetros de conexão forem inválidos.
 */
export function createMigrationConnection(): MigrationConnection {
  const pool = createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: 1,
  });
  return { pool, db: drizzle(pool, { mode: 'default' }) };
}

/**
 * Lista os nomes das migrations existentes (sem extensão), em ordem crescente.
 *
 * @param dir - Pasta a listar. Padrão: a pasta das migrations compiladas.
 * @returns Nomes como `0000_create_orders_table`.
 * @throws Error se a pasta de migrations não puder ser lida.
 */
export async function listMigrationNames(
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = await readdir(dir);
  return files
    .filter(
      (file) => /^\d{4}_.+\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'),
    )
    .map((file) => file.replace(/\.(ts|js)$/, ''))
    .sort();
}

/**
 * Importa o módulo compilado de uma migration.
 *
 * @param name - Nome da migration, sem extensão.
 * @returns Módulo com os métodos `up` e `down`.
 * @throws Error se o arquivo não existir ou não exportar `up` e `down`.
 */
export async function loadMigration(name: string): Promise<Migration> {
  const module: Partial<Migration> = await import(
    pathToFileURL(resolve(MIGRATIONS_DIR, `${name}.js`)).href
  );
  if (typeof module.up !== 'function' || typeof module.down !== 'function') {
    throw new Error(`Migration ${name} deve exportar as funções up e down`);
  }
  return module as Migration;
}

/**
 * Cria a tabela de controle de migrations, caso ainda não exista.
 *
 * @param database - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando a tabela existir.
 * @throws Erro do driver se a criação falhar.
 */
export async function ensureMigrationsTable(database: Database): Promise<void> {
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Consulta as migrations aplicadas, da mais recente para a mais antiga.
 *
 * @param database - Instância do Drizzle conectada ao banco.
 * @param limit - Quantidade máxima de registros. Sem valor, retorna todos.
 * @returns Migrations aplicadas em ordem decrescente de aplicação.
 * @throws Erro do driver se a consulta falhar.
 */
export async function getAppliedMigrations(
  database: Database,
  limit?: number,
): Promise<AppliedMigration[]> {
  const [rows] = (await database.execute(
    limit === undefined
      ? sql`SELECT id, name FROM migrations ORDER BY id DESC`
      : sql`SELECT id, name FROM migrations ORDER BY id DESC LIMIT ${limit}`,
  )) as unknown as [AppliedMigration[]];
  return rows;
}

/**
 * Lê o snapshot do schema da última migration gerada.
 *
 * @returns Snapshot em JSON, ou `null` se ainda não houver migrations geradas.
 * @throws Error se o arquivo existir mas for inválido.
 */
export async function readSnapshot(): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Grava o snapshot do schema atual.
 *
 * @param snapshot - Snapshot em JSON gerado a partir do `schema.ts`.
 * @returns Promise resolvida quando o arquivo for gravado.
 * @throws Error se a gravação falhar.
 */
export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
}
