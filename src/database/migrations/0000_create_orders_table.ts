import { sql } from 'drizzle-orm';
import type { Database } from '../migration-files.js';

/**
 * Aplica a migration 0000_create_orders_table.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem aplicadas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function up(db: Database): Promise<void> {
  await db.execute(sql`CREATE TABLE \`orders\` (
	\`id\` int AUTO_INCREMENT NOT NULL,
	\`customer_email\` varchar(255) NOT NULL,
	\`product\` varchar(255) NOT NULL,
	\`amount\` decimal(10,2) NOT NULL,
	\`created_at\` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT \`orders_id\` PRIMARY KEY(\`id\`)
);
`);
}

/**
 * Reverte a migration 0000_create_orders_table.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem revertidas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function down(db: Database): Promise<void> {
  await db.execute(sql`DROP TABLE \`orders\`;`);
}
