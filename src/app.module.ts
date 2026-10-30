import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { QueueModule } from './queue/queue.module.js';

/**
 * Módulo raiz da aplicação: configuração, infraestrutura, domínio, pipe de validação e interceptor de serialização Zod.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => env],
    }),
    DatabaseModule,
    QueueModule,
    HealthModule,
    OrdersModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
