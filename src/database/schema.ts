import {
  decimal,
  int,
  mysqlTable,
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
