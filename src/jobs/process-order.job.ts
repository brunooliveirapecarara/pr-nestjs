import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { ORDER_STATUS, type OrderStatus } from '../database/schema.js';
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
 * Processa um pedido apenas registrando o ciclo de vida, sem efeitos externos reais.
 *
 * É idempotente: a entrega da fila é "pelo menos uma vez", então o job reivindica o pedido com uma
 * transição condicional (`pending -> processing`) e ignora a mensagem se outra execução já o reivindicou
 * ou concluiu.
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

  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
  ) {}

  /**
   * Processa um pedido registrando o ciclo de vida do job. Se o processamento falhar, devolve o pedido a
   * `pending` para que a retentativa possa reivindicá-lo de novo.
   *
   * @param order - Dados do pedido a processar.
   * @returns Promise resolvida quando o processamento terminar, ou imediatamente se o pedido já foi tratado.
   * @throws Erro do driver ou do processamento; o pedido volta a `pending` antes de o erro propagar.
   */
  async handle(order: OrderMessage): Promise<void> {
    const claimed = await this.transition(
      order.orderId,
      ORDER_STATUS.pending,
      ORDER_STATUS.processing,
    );
    if (!claimed) {
      this.logger.warn(
        `⏭️ Pedido #${order.orderId} não está pendente (já processado, em processamento ou inexistente); ignorando`,
      );
      return;
    }

    try {
      this.logger.log(
        `⚙️ Processando pedido #${order.orderId} de ${order.customerEmail}`,
      );
      await setTimeout(500);
      await this.transition(
        order.orderId,
        ORDER_STATUS.processing,
        ORDER_STATUS.processed,
      );
      this.logger.log(
        `✅ Concluído pedido #${order.orderId} (${order.product})`,
      );
    } catch (error) {
      await this.transition(
        order.orderId,
        ORDER_STATUS.processing,
        ORDER_STATUS.pending,
      );
      throw error;
    }
  }

  /**
   * Muda o status de um pedido apenas se ele ainda estiver no status esperado.
   *
   * @param orderId - Id do pedido.
   * @param from - Status que o pedido deve ter para a mudança ocorrer.
   * @param to - Novo status.
   * @returns `true` se esta chamada fez a transição; `false` se o pedido não estava em `from`.
   * @throws Erro do driver se o update falhar.
   */
  private async transition(
    orderId: number,
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<boolean> {
    const [result] = await this.db
      .update(schema.orders)
      .set({ status: to })
      .where(
        and(eq(schema.orders.id, orderId), eq(schema.orders.status, from)),
      );
    return result.affectedRows > 0;
  }
}
