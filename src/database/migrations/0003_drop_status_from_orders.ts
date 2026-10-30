import { sql } from 'drizzle-orm';
import type { Database } from '../migration-files.js';

/**
 * Aplica a migration 0003_drop_status_from_orders.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem aplicadas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function up(db: Database): Promise<void> {
  await db.execute(sql`ALTER TABLE \`orders\` DROP COLUMN \`status\`;`);
}

/**
 * Reverte a migration 0003_drop_status_from_orders.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem revertidas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function down(db: Database): Promise<void> {
  await db.execute(
    sql`ALTER TABLE \`orders\` ADD \`status\` varchar(20) DEFAULT 'pending' NOT NULL;`,
  );
}
