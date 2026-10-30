import { Inject, Injectable } from '@nestjs/common';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { JobStore } from '../queue/job-store.service.js';
import type { CreateOrderDto, OrderResponseDto } from './order.schema.js';

/**
 * Regras de negócio de pedidos.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
    private readonly jobs: JobStore,
  ) {}

  /**
   * Persiste o pedido e grava o job `process_order` na tabela `jobs`, na mesma transação (outbox): ou os
   * dois são confirmados ou nenhum. O `JobPublisher` envia o job à fila depois, mesmo que o RabbitMQ
   * esteja fora do ar neste momento.
   *
   * @param input - Dados validados do pedido.
   * @returns Pedido criado com o `id` gerado.
   * @throws Erro do driver se o insert do pedido ou do job falhar (a transação é desfeita).
   */
  async create(input: CreateOrderDto): Promise<OrderResponseDto> {
    const orderId = await this.db.transaction(async (tx) => {
      const [result] = await tx.insert(schema.orders).values({
        customerEmail: input.customer_email,
        product: input.product,
        amount: input.amount.toFixed(2),
      });

      await this.jobs.enqueue(tx, ProcessOrderJob, {
        orderId: result.insertId,
        customerEmail: input.customer_email,
        product: input.product,
        amount: input.amount,
      });

      return result.insertId;
    });

    return {
      id: orderId,
      customer_email: input.customer_email,
      product: input.product,
      amount: input.amount,
    };
  }
}
