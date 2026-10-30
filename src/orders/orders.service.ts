import { Inject, Injectable } from '@nestjs/common';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { QueueService } from '../queue/queue.service.js';
import type { CreateOrderDto, OrderResponseDto } from './order.schema.js';

/**
 * Regras de negócio de pedidos.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
    private readonly queue: QueueService,
  ) {}

  /**
   * Persiste o pedido e despacha o job `process_order`.
   *
   * @param input - Dados validados do pedido.
   * @returns Pedido criado com o `id` gerado.
   * @throws Erro do driver se o insert falhar, ou da fila se o dispatch falhar.
   */
  async create(input: CreateOrderDto): Promise<OrderResponseDto> {
    const [result] = await this.db.insert(schema.orders).values({
      customerEmail: input.customer_email,
      product: input.product,
      amount: input.amount.toFixed(2),
    });

    this.queue.dispatch(ProcessOrderJob, {
      orderId: result.insertId,
      customerEmail: input.customer_email,
      product: input.product,
      amount: input.amount,
    });

    return {
      id: result.insertId,
      customer_email: input.customer_email,
      product: input.product,
      amount: input.amount,
    };
  }
}
