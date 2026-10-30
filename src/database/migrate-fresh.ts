import { sql } from 'drizzle-orm';
import { createMigrationConnection, type Database } from './migration-files.js';
import { migrateUp } from './migrate-up.js';

/**
 * Remove todas as tabelas do banco atual, incluindo a tabela de controle de migrations.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando todas as tabelas forem removidas.
 * @throws Erro do driver se a listagem ou a remoção falhar.
 */
async function dropAllTables(db: Database): Promise<void> {
  const [rows] = (await db.execute(
    sql`SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE()`,
  )) as unknown as [{ table_name: string }[]];

  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const { table_name } of rows) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS \`${table_name}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

/**
 * Recria o banco do zero: remove todas as tabelas e reaplica todas as migrations.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando o banco estiver recriado.
 * @throws Erro propagado de `dropAllTables` ou `migrateUp`.
 */
export async function migrateFresh(db: Database): Promise<void> {
  await dropAllTables(db);
  await migrateUp(db);
}

if (import.meta.main) {
  const { pool, db } = createMigrationConnection();
  try {
    await migrateFresh(db);
  } catch (error) {
    console.error('❌ Falha ao recriar o banco:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
