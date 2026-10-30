import { sql } from 'drizzle-orm';
import {
  createMigrationConnection,
  type Database,
  ensureMigrationsTable,
  getAppliedMigrations,
  listMigrationNames,
  loadMigration,
} from './migration-files.js';

/**
 * Aplica, em ordem, todas as migrations ainda não registradas na tabela `migrations`.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando todas as migrations pendentes forem aplicadas.
 * @throws Erro do driver ou da própria migration se alguma falhar; as anteriores permanecem aplicadas.
 */
export async function migrateUp(db: Database): Promise<void> {
  await ensureMigrationsTable(db);

  const applied = new Set(
    (await getAppliedMigrations(db)).map((item) => item.name),
  );
  const pending = (await listMigrationNames()).filter(
    (name) => !applied.has(name),
  );

  if (pending.length === 0) {
    console.log('ℹ️ Nenhuma migration pendente');
    return;
  }

  for (const name of pending) {
    const migration = await loadMigration(name);
    await migration.up(db);
    await db.execute(sql`INSERT INTO migrations (name) VALUES (${name})`);
    console.log(`⬆️ Migration aplicada: ${name}`);
  }

  console.log('✅ Migrations aplicadas com sucesso');
}

if (import.meta.main) {
  const { pool, db } = createMigrationConnection();
  try {
    await migrateUp(db);
  } catch (error) {
    console.error('❌ Falha ao aplicar migrations:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
