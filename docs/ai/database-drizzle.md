# Banco de dados: Drizzle ORM + MariaDB

## Schema — `src/database/schema.ts`

```ts
import { decimal, int, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

export const orders = mysqlTable('orders', {
  id: int('id').autoincrement().primaryKey(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  product: varchar('product', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

Mantenha as colunas idênticas às do projeto original (`bun-fastify/src/db/schema.ts`); confira antes de portar.

## Módulo — `src/database/database.module.ts`

```ts
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { env } from '../config/env.js';
import { DRIZZLE } from './database.constants.js';
import * as schema from './schema.js';

const POOL = Symbol('MYSQL_POOL');

/**
 * Módulo global que expõe a instância do Drizzle (`DRIZZLE`) e gerencia o pool `mysql2`.
 */
@Global()
@Module({
  providers: [
    {
      provide: POOL,
      useFactory: (): Pool =>
        createPool({
          host: env.DB_HOST,
          port: env.DB_PORT,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          database: env.DB_NAME,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema, mode: 'default' }),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Fecha o pool de conexões no encerramento da aplicação.
   *
   * @returns Promise resolvida quando o pool estiver fechado.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
```

(Adicione `Inject` ao import de `@nestjs/common`.)

## Uso

Serviços recebem `@Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>`. Nunca crie outro pool nem importe uma instância global de `db`.

## Sistema de migrations próprio

Mesmo comportamento do projeto original, agora em `src/database/`:

- `migration-generate.ts` — `yarn migration:generate <nome>`: compara `schema.ts` com `migrations/snapshot.json` e escreve `migrations/NNNN_nome.ts` com `up` e `down`.
- `migration-files.ts` — tipos `Migration`, listagem/carga dos arquivos, tabela de controle `migrations`, leitura/escrita do snapshot.
- `migrate-up.ts` — aplica as migrations pendentes.
- `migrate-down.ts` — reverte as últimas N (`--step=N`, padrão 1).
- `migrate-fresh.ts` — derruba tudo e reaplica.

Esses scripts são **standalone** (criam seu próprio pool `mysql2`, sem subir o Nest) e rodam compilados (`nest build` -> `node dist/database/<script>.js`), sem Nest.

Formato de um arquivo de migration:

```ts
import { sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';

/**
 * Cria a tabela `orders`.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando o SQL for executado.
 */
export async function up(db: MySql2Database): Promise<void> {
  await db.execute(sql`CREATE TABLE orders (...)`);
}

/**
 * Remove a tabela `orders`.
 *
 * @param db - Instância do Drizzle conectada ao banco.
 * @returns Promise resolvida quando o SQL for executado.
 */
export async function down(db: MySql2Database): Promise<void> {
  await db.execute(sql`DROP TABLE orders`);
}
```

Ao portar, copie a lógica de `bun-fastify/src/db/migration-*.ts` e `migrate-*.ts`, ajustando apenas caminhos (`db` -> `database`).
