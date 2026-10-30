import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueService } from './queue.service.js';

/**
 * Módulo global da fila RabbitMQ: descobre os jobs e expõe o `QueueService`.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
