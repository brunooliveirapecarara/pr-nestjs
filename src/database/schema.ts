import {
  decimal,
  index,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * Tabela de pedidos recebidos via HTTP.
 */
export const orders = mysqlTable('orders', {
  id: int('id').autoincrement().primaryKey(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  product: varchar('product', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * Tipo de um registro lido da tabela `orders`.
 */
export type Order = typeof orders.$inferSelect;

/**
 * Tipo de um registro a ser inserido na tabela `orders`.
 */
export type NewOrder = typeof orders.$inferInsert;

/**
 * Estados do ciclo de vida de um job: `pending` (gravado, ainda não publicado), `published` (confirmado
 * pelo broker), `processing` (reivindicado por um worker), `done` (concluído) e `failed` (esgotou as
 * tentativas ou é irrecuperável; foi para a DLQ).
 */
export const JOB_STATUS = {
  pending: 'pending',
  published: 'published',
  processing: 'processing',
  done: 'done',
  failed: 'failed',
} as const;

/**
 * Valor possível da coluna `jobs.status`.
 */
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/**
 * Tabela de jobs: serve de outbox (gravada na mesma transação do dado de negócio e publicada depois) e de
 * registro do ciclo de vida de cada job. O `id` viaja como `messageId` e é a chave de idempotência.
 */
export const jobs = mysqlTable(
  'jobs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    queue: varchar('queue', { length: 100 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    payload: json('payload').$type<unknown>().notNull(),
    status: varchar('status', { length: 20 })
      .$type<JobStatus>()
      .notNull()
      .default(JOB_STATUS.pending),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { fsp: 3 }),
    startedAt: timestamp('started_at', { fsp: 3 }),
    finishedAt: timestamp('finished_at', { fsp: 3 }),
  },
  (table) => [
    index('jobs_status_created_at_idx').on(table.status, table.createdAt),
  ],
);

/**
 * Tipo de um registro lido da tabela `jobs`.
 */
export type JobRecord = typeof jobs.$inferSelect;
