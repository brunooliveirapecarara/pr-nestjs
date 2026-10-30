import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../database/database.constants.js';
import { orders } from '../database/schema.js';
import { ProcessOrderJob, type OrderMessage } from './process-order.job.js';

const order: OrderMessage = {
  orderId: 7,
  customerEmail: 'a@b.com',
  product: 'Teclado',
  amount: 19.9,
};

describe('ProcessOrderJob', () => {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  let job: ProcessOrderJob;

  /**
   * Resultado de um `UPDATE` do mysql2 com a quantidade de linhas afetadas.
   *
   * @param affectedRows - Linhas alteradas pelo update.
   * @returns Tupla no formato devolvido pelo Drizzle.
   */
  const affected = (affectedRows: number): [{ affectedRows: number }] => [
    { affectedRows },
  ];

  /**
   * Status gravados, na ordem dos updates.
   *
   * @returns Lista dos valores passados a `set`.
   */
  const statuses = (): unknown[] =>
    set.mock.calls.map(([values]) => (values as { status: string }).status);

  beforeEach(async () => {
    vi.clearAllMocks();
    where.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [ProcessOrderJob, { provide: DRIZZLE, useValue: { update } }],
    })
      .setLogger({ log: vi.fn(), error: vi.fn(), warn: vi.fn() })
      .compile();
    job = moduleRef.get(ProcessOrderJob);
  });

  it('reivindica o pedido pendente, processa e conclui', async () => {
    where.mockResolvedValue(affected(1));

    await job.handle(order);

    expect(update).toHaveBeenCalledWith(orders);
    expect(statuses()).toEqual(['processing', 'processed']);
  });

  it('ignora a duplicata quando o pedido já não está pendente', async () => {
    where.mockResolvedValue(affected(0));

    await job.handle(order);

    expect(statuses()).toEqual(['processing']);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('só uma de duas entregas simultâneas processa o pedido', async () => {
    where
      .mockResolvedValueOnce(affected(1))
      .mockResolvedValueOnce(affected(0))
      .mockResolvedValue(affected(1));

    await Promise.all([job.handle(order), job.handle(order)]);

    expect(statuses().filter((status) => status === 'processed')).toHaveLength(
      1,
    );
  });

  it('devolve o pedido a pending e propaga o erro se o processamento falhar', async () => {
    where
      .mockResolvedValueOnce(affected(1))
      .mockRejectedValueOnce(new Error('db caiu'))
      .mockResolvedValueOnce(affected(1));

    await expect(job.handle(order)).rejects.toThrow('db caiu');

    expect(statuses()).toEqual(['processing', 'processed', 'pending']);
  });

  it('não reivindica nada se a consulta inicial falhar', async () => {
    where.mockRejectedValue(new Error('db caiu'));

    await expect(job.handle(order)).rejects.toThrow('db caiu');

    expect(statuses()).toEqual(['processing']);
  });

  it('registra o ciclo de vida só quando reivindica o pedido', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});

    where.mockResolvedValue(affected(1));
    await job.handle(order);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('⚙️'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('✅'));
    expect(warn).not.toHaveBeenCalled();

    log.mockClear();
    where.mockResolvedValue(affected(0));
    await job.handle(order);
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('⏭️'));
  });
});
