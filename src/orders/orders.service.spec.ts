import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../database/database.constants.js';
import { orders } from '../database/schema.js';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { QueueService } from '../queue/queue.service.js';
import { OrdersService } from './orders.service.js';

describe('OrdersService', () => {
  const values = vi.fn();
  const insert = vi.fn(() => ({ values }));
  const dispatch = vi.fn();
  let service: OrdersService;

  beforeEach(async () => {
    vi.clearAllMocks();
    dispatch.mockReset();
    values.mockResolvedValue([{ insertId: 42 }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DRIZZLE, useValue: { insert } },
        { provide: QueueService, useValue: { dispatch } },
      ],
    }).compile();
    service = moduleRef.get(OrdersService);
  });

  it('persiste o pedido com o valor em duas casas decimais', async () => {
    await service.create({
      customer_email: 'a@b.com',
      product: 'Teclado',
      amount: 19.9,
    });

    expect(insert).toHaveBeenCalledWith(orders);
    expect(values).toHaveBeenCalledWith({
      customerEmail: 'a@b.com',
      product: 'Teclado',
      amount: '19.90',
    });
  });

  it('despacha o job process_order com o id gerado', async () => {
    await service.create({
      customer_email: 'a@b.com',
      product: 'Teclado',
      amount: 19.9,
    });

    expect(dispatch).toHaveBeenCalledWith(ProcessOrderJob, {
      orderId: 42,
      customerEmail: 'a@b.com',
      product: 'Teclado',
      amount: 19.9,
    });
  });

  it('retorna o pedido criado com o id', async () => {
    await expect(
      service.create({ customer_email: 'a@b.com', product: 'X', amount: 5 }),
    ).resolves.toEqual({
      id: 42,
      customer_email: 'a@b.com',
      product: 'X',
      amount: 5,
    });
  });

  it('não despacha o job quando o insert falha', async () => {
    values.mockRejectedValue(new Error('db fora do ar'));

    await expect(
      service.create({ customer_email: 'a@b.com', product: 'X', amount: 5 }),
    ).rejects.toThrow('db fora do ar');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('propaga o erro quando a fila está indisponível', async () => {
    dispatch.mockImplementation(() => {
      throw new Error('Fila indisponível: sem conexão com o RabbitMQ');
    });

    await expect(
      service.create({ customer_email: 'a@b.com', product: 'X', amount: 5 }),
    ).rejects.toThrow('Fila indisponível');
  });
});
