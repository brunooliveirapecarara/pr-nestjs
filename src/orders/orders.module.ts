import { Module } from '@nestjs/common';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';

/**
 * Módulo de domínio de pedidos.
 */
@Module({
  controllers: [OrdersController],
  providers: [OrdersService, ProcessOrderJob],
  exports: [OrdersService],
})
export class OrdersModule {}
