import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { env } from '../config/env.js';
import { DRIZZLE, MYSQL_POOL } from './database.constants.js';
import * as schema from './schema.js';

/**
 * Módulo global que expõe a instância do Drizzle (`DRIZZLE`) e gerencia o pool `mysql2`.
 */
@Global()
@Module({
  providers: [
    {
      provide: MYSQL_POOL,
      useFactory: (): Pool =>
        createPool({
          host: env.DB_HOST,
          port: env.DB_PORT,
          user: env.DB_USER,
          password: env.DB_PASSWORD,
          database: env.DB_NAME,
          connectionLimit: 10,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [MYSQL_POOL],
      useFactory: (pool: Pool): MySql2Database<typeof schema> =>
        drizzle(pool, { schema, mode: 'default' }),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MYSQL_POOL) private readonly pool: Pool) {}

  /**
   * Fecha o pool de conexões no encerramento da aplicação.
   *
   * @returns Promise resolvida quando o pool estiver fechado.
   * @throws Erro do driver caso o pool não consiga ser encerrado.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
