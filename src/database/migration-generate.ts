import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateMySQLDrizzleJson,
  generateMySQLMigration,
} from 'drizzle-kit/api';
import {
  listMigrationNames,
  readSnapshot,
  SOURCE_MIGRATIONS_DIR,
  writeSnapshot,
} from './migration-files.js';
import * as schema from './schema.js';

/**
 * Escapa um trecho de SQL para ser embutido em um template literal do JavaScript.
 *
 * @param statement - Instrução SQL.
 * @returns A instrução com crases, barras invertidas e `${` escapados.
 */
function escapeForTemplate(statement: string): string {
  return statement
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/**
 * Monta o corpo de um método de migration a partir de instruções SQL.
 *
 * @param statements - Instruções SQL a executar.
 * @returns Linhas de código com um `db.execute(sql\`...\`)` por instrução.
 */
function renderStatements(statements: string[]): string {
  return statements
    .map(
      (statement) =>
        `  await db.execute(sql\`${escapeForTemplate(statement)}\`);`,
    )
    .join('\n');
}

/**
 * Monta o conteúdo completo do arquivo de uma migration.
 *
 * @param name - Nome legível da migration.
 * @param up - Instruções SQL do `up`.
 * @param down - Instruções SQL do `down`.
 * @returns Código-fonte TypeScript da migration.
 */
function renderMigration(name: string, up: string[], down: string[]): string {
  return `import { sql } from 'drizzle-orm';
import type { Database } from '../migration-files.js';

/**
 * Aplica a migration ${name}.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem aplicadas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function up(db: Database): Promise<void> {
${renderStatements(up)}
}

/**
 * Reverte a migration ${name}.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando as alterações forem revertidas.
 * @throws Erro do driver se alguma instrução falhar.
 */
export async function down(db: Database): Promise<void> {
${renderStatements(down)}
}
`;
}

/**
 * Gera um arquivo de migration com `up` e `down` a partir da diferença entre o `schema.ts` e o último snapshot.
 *
 * @param name - Nome da migration (ex.: `add_status_to_orders`).
 * @returns Promise resolvida quando o arquivo e o snapshot forem gravados.
 * @throws Error se o schema não tiver mudado desde a última migration.
 */
export async function generateMigration(name: string): Promise<void> {
  const current = await generateMySQLDrizzleJson(schema);
  const previous =
    (await readSnapshot()) ?? (await generateMySQLDrizzleJson({}));

  const up = await generateMySQLMigration(previous, current);
  if (up.length === 0) {
    throw new Error('Nenhuma migration criada: o schema não mudou');
  }
  const down = await generateMySQLMigration(current, previous);

  const index = String(
    (await listMigrationNames(SOURCE_MIGRATIONS_DIR)).length,
  ).padStart(4, '0');
  const fileName = `${index}_${name}`;
  const path = join(SOURCE_MIGRATIONS_DIR, `${fileName}.ts`);

  await writeFile(path, renderMigration(fileName, up, down));
  await writeSnapshot(current);
  console.log(`✅ Migration gerada: ${path}`);
}

if (import.meta.main) {
  const name = process.argv[2];
  if (!name) {
    console.error('Uso: yarn migration:generate <nome_da_migration>');
    process.exit(1);
  }

  try {
    await generateMigration(name);
  } catch (error) {
    console.error('❌ Falha ao gerar migration:', error);
    process.exit(1);
  }
}
