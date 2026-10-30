# Banco de dados: Drizzle ORM + MariaDB

## Schema — `src/database/schema.ts`

```ts
import { decimal, index, int, json, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core';

export const orders = mysqlTable('orders', {
  id: int('id').autoincrement().primaryKey(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  product: varchar('product', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const JOB_STATUS = {
  pending: 'pending',
  published: 'published',
  processing: 'processing',
  done: 'done',
  failed: 'failed',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const jobs = mysqlTable(
  'jobs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    queue: varchar('queue', { length: 100 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    payload: json('payload').$type<unknown>().notNull(),
    status: varchar('status', { length: 20 }).$type<JobStatus>().notNull().default(JOB_STATUS.pending),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { fsp: 3 }),
    startedAt: timestamp('started_at', { fsp: 3 }),
    finishedAt: timestamp('finished_at', { fsp: 3 }),
  },
  (table) => [index('jobs_status_created_at_idx').on(table.status, table.createdAt)],
);
```

A tabela `orders` é idêntica à do projeto original (`bun-fastify/src/db/schema.ts`). A tabela `jobs` é um acréscimo deste projeto (migration `0002_create_jobs_table`) e serve de **outbox** e de **registro do ciclo de vida** dos jobs (ver `queue-rabbitmq.md`):

- `pending`: gravado na mesma transação do dado de negócio, ainda não publicado.
- `published`: confirmado pelo broker (também é o estado de um job aguardando retry).
- `processing`: reivindicado por um worker (`started_at` marca o início; passado o lease, outra entrega pode reassumi-lo).
- `done` / `failed`: terminais. `failed` = foi para a DLQ e guarda `last_error`.
- `attempts` conta as execuções iniciadas. O índice `(status, created_at)` serve à varredura do publicador.

Histórico: a `0001` adicionou `orders.status` e a `0003` o removeu, quando a idempotência passou para a tabela `jobs`.

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
