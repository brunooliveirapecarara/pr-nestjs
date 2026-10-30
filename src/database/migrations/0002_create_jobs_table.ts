import { sql } from 'drizzle-orm';
import type { Database } from '../migration-files.js';

/**
 * Aplica a migration 0002_create_jobs_table.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem aplicadas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function up(db: Database): Promise<void> {
  await db.execute(sql`CREATE TABLE \`jobs\` (
	\`id\` varchar(36) NOT NULL,
	\`queue\` varchar(100) NOT NULL,
	\`name\` varchar(100) NOT NULL,
	\`payload\` json NOT NULL,
	\`status\` varchar(20) NOT NULL DEFAULT 'pending',
	\`attempts\` int NOT NULL DEFAULT 0,
	\`last_error\` text,
	\`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
	\`published_at\` timestamp(3),
	\`started_at\` timestamp(3),
	\`finished_at\` timestamp(3),
	CONSTRAINT \`jobs_id\` PRIMARY KEY(\`id\`)
);
`);
  await db.execute(
    sql`CREATE INDEX \`jobs_status_created_at_idx\` ON \`jobs\` (\`status\`,\`created_at\`);`,
  );
}

/**
 * Reverte a migration 0002_create_jobs_table.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem revertidas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function down(db: Database): Promise<void> {
  await db.execute(sql`DROP TABLE \`jobs\`;`);
}
