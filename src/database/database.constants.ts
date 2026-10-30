/**
 * Token de injeção da instância do Drizzle (`MySql2Database<typeof schema>`).
 */
export const DRIZZLE = Symbol('DRIZZLE');

/**
 * Token de injeção do pool `mysql2` usado pelo Drizzle.
 */
export const MYSQL_POOL = Symbol('MYSQL_POOL');
