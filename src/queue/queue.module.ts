import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { JobPublisher } from './job-publisher.service.js';
import { JobStore } from './job-store.service.js';
import { QueueService } from './queue.service.js';

/**
 * Módulo global da fila RabbitMQ: descobre os jobs, expõe o `QueueService` e o `JobStore` (tabela `jobs`)
 * e roda o `JobPublisher`, que publica os jobs gravados na tabela.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [QueueService, JobStore, JobPublisher],
  exports: [QueueService, JobStore],
})
export class QueueModule {}
