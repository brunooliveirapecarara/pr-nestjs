import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../database/database.constants.js';
import { orders } from '../database/schema.js';
import { ProcessOrderJob } from '../jobs/process-order.job.js';
import { JobStore } from '../queue/job-store.service.js';
import { OrdersService } from './orders.service.js';

describe('OrdersService', () => {
  const values = vi.fn();
  const tx = { insert: vi.fn(() => ({ values })) };
  const transaction = vi.fn(
    async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const enqueue = vi.fn();
  let service: OrdersService;

  beforeEach(async () => {
    vi.clearAllMocks();
    values.mockResolvedValue([{ insertId: 42 }]);
    enqueue.mockResolvedValue('job-id');

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: DRIZZLE, useValue: { transaction } },
        { provide: JobStore, useValue: { enqueue } },
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

    expect(tx.insert).toHaveBeenCalledWith(orders);
    expect(values).toHaveBeenCalledWith({
      customerEmail: 'a@b.com',
      product: 'Teclado',
      amount: '19.90',
    });
  });

  it('grava o job process_order na mesma transação, com o id gerado', async () => {
    await service.create({
      customer_email: 'a@b.com',
      product: 'Teclado',
      amount: 19.9,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(tx, ProcessOrderJob, {
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

  it('não grava o job quando o insert do pedido falha', async () => {
    values.mockRejectedValue(new Error('db fora do ar'));

    await expect(
      service.create({ customer_email: 'a@b.com', product: 'X', amount: 5 }),
    ).rejects.toThrow('db fora do ar');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propaga o erro (desfazendo a transação) quando o job não pode ser gravado', async () => {
    enqueue.mockRejectedValue(new Error('falha ao gravar o job'));

    await expect(
      service.create({ customer_email: 'a@b.com', product: 'X', amount: 5 }),
    ).rejects.toThrow('falha ao gravar o job');
  });
});
