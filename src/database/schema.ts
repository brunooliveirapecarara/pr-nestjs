import {
  decimal,
  int,
  mysqlTable,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core';

/**
 * Estados do ciclo de vida de um pedido: `pending` (criado), `processing` (reivindicado por um worker)
 * e `processed` (concluído). A transição `pending -> processing` é a trava de idempotência do job.
 */
export const ORDER_STATUS = {
  pending: 'pending',
  processing: 'processing',
  processed: 'processed',
} as const;

/**
 * Valor possível da coluna `orders.status`.
 */
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/**
 * Tabela de pedidos recebidos via HTTP.
 */
export const orders = mysqlTable('orders', {
  id: int('id').autoincrement().primaryKey(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  product: varchar('product', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 })
    .$type<OrderStatus>()
    .notNull()
    .default(ORDER_STATUS.pending),
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
