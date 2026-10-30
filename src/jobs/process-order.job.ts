import { setTimeout } from 'node:timers/promises';
import { Injectable, Logger } from '@nestjs/common';
import { Job, type JobHandler } from '../queue/job.decorator.js';

/**
 * Dados do pedido enviados ao job `process_order`.
 */
export interface OrderMessage {
  orderId: number;
  customerEmail: string;
  product: string;
  amount: number;
}

/**
 * Processa um pedido apenas registrando o ciclo de vida, sem efeitos externos reais. A idempotência é
 * garantida pelo `QueueService`, que reivindica o job na tabela `jobs` antes de chamar o `handle`.
 */
@Injectable()
@Job({
  queue: 'order_processing',
  name: 'process_order',
  retries: 3,
  backoffMs: 5000,
})
export class ProcessOrderJob implements JobHandler<OrderMessage> {
  private readonly logger = new Logger(ProcessOrderJob.name);

  /**
   * Processa um pedido registrando o ciclo de vida do job.
   *
   * @param order - Dados do pedido a processar.
   * @returns Promise resolvida quando o processamento terminar.
   */
  async handle(order: OrderMessage): Promise<void> {
    this.logger.log(
      `⚙️ Processando pedido #${order.orderId} de ${order.customerEmail}`,
    );
    await setTimeout(500);
    this.logger.log(`✅ Concluído pedido #${order.orderId} (${order.product})`);
  }
}
