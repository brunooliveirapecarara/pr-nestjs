import { sql } from 'drizzle-orm';
import {
  createMigrationConnection,
  type Database,
  ensureMigrationsTable,
  getAppliedMigrations,
  loadMigration,
} from './migration-files.js';

/**
 * Reverte as últimas migrations aplicadas, da mais recente para a mais antiga,
 * executando o `down` de cada uma e removendo seu registro de controle.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @param steps - Quantidade de migrations a reverter. Padrão: 1.
 * @returns Promise resolvida quando as migrations forem revertidas, ou imediatamente se não houver nenhuma aplicada.
 * @throws Error se o arquivo de uma migration aplicada não existir ou se o `down` falhar.
 */
export async function migrateDown(db: Database, steps = 1): Promise<void> {
  await ensureMigrationsTable(db);

  const applied = await getAppliedMigrations(db, steps);
  if (applied.length === 0) {
    console.log('ℹ️ Nenhuma migration aplicada para reverter');
    return;
  }

  for (const { id, name } of applied) {
    const migration = await loadMigration(name);
    await migration.down(db);
    await db.execute(sql`DELETE FROM migrations WHERE id = ${id}`);
    console.log(`⬇️ Migration revertida: ${name}`);
  }
}

/**
 * Lê o argumento `--step=N` da linha de comando.
 *
 * @param args - Argumentos recebidos pelo processo.
 * @returns Quantidade de steps informada, ou 1 se o argumento não existir.
 * @throws Error se o valor informado não for um inteiro positivo.
 */
function parseSteps(args: string[]): number {
  const arg = args.find((item) => item.startsWith('--step='));
  if (!arg) return 1;

  const steps = Number(arg.slice('--step='.length));
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error('--step deve ser um inteiro positivo (ex.: --step=2)');
  }
  return steps;
}

if (import.meta.main) {
  const { pool, db } = createMigrationConnection();
  try {
    await migrateDown(db, parseSteps(process.argv.slice(2)));
  } catch (error) {
    console.error('❌ Falha ao reverter migration:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
