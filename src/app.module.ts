import { Controller, Get, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { DatabaseModule } from './database/database.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { QueueModule } from './queue/queue.module.js';

/**
 * Endpoint de healthcheck da aplicação.
 */
@Controller('health')
export class HealthController {
  /**
   * Healthcheck simples da aplicação.
   *
   * @returns Objeto indicando que o serviço está no ar.
   */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

/**
 * Módulo raiz da aplicação: infraestrutura, domínio, pipe de validação e interceptor de serialização Zod.
 */
@Module({
  imports: [DatabaseModule, QueueModule, OrdersModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
