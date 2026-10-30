import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../database/database.constants.js';
import type { JobRecord } from '../database/schema.js';
import { JobPublisher } from './job-publisher.service.js';
import { JobStore } from './job-store.service.js';
import { JOB_PUBLISH_BATCH_SIZE } from './queue.config.js';
import { QueueService } from './queue.service.js';

/**
 * Cria um job `pending` de teste.
 *
 * @param id - Id do job.
 * @returns Registro no formato da tabela `jobs`.
 */
function pendingJob(id: string): JobRecord {
  return {
    id,
    queue: 'q',
    name: 'sample',
    payload: { id },
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    publishedAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

describe('JobPublisher', () => {
  const lockFor = vi.fn();
  const limit = vi.fn(() => ({ for: lockFor }));
  const orderBy = vi.fn(() => ({ limit }));
  const selectWhere = vi.fn(() => ({ orderBy }));
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const tx = {
    select: () => ({ from: () => ({ where: selectWhere }) }),
    update: vi.fn(() => ({ set })),
  };
  const transaction = vi.fn(
    async (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const publish = vi.fn();
  const purgeDone = vi.fn();
  let publisher: JobPublisher;

  beforeEach(async () => {
    vi.clearAllMocks();
    publish.mockResolvedValue(undefined);
    updateWhere.mockResolvedValue([{ affectedRows: 1 }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobPublisher,
        { provide: DRIZZLE, useValue: { transaction } },
        { provide: QueueService, useValue: { publish } },
        { provide: JobStore, useValue: { purgeDone } },
      ],
    })
      .setLogger({ log: vi.fn(), error: vi.fn(), warn: vi.fn() })
      .compile();
    publisher = moduleRef.get(JobPublisher);
  });

  it('trava as linhas pending com FOR UPDATE SKIP LOCKED e respeita o lote', async () => {
    lockFor.mockResolvedValue([]);

    await publisher.publishPending();

    expect(lockFor).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(limit).toHaveBeenCalledWith(JOB_PUBLISH_BATCH_SIZE);
  });

  it('publica cada job com o id como messageId e o marca como published', async () => {
    lockFor.mockResolvedValue([pendingJob('a'), pendingJob('b')]);

    await expect(publisher.publishPending()).resolves.toBe(2);

    expect(publish).toHaveBeenNthCalledWith(1, 'q', 'sample', { id: 'a' }, 'a');
    expect(publish).toHaveBeenNthCalledWith(2, 'q', 'sample', { id: 'b' }, 'b');
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith({
      status: 'published',
      publishedAt: expect.any(Date),
    });
  });

  it('não faz nada quando não há jobs pending', async () => {
    lockFor.mockResolvedValue([]);

    await expect(publisher.publishPending()).resolves.toBe(0);

    expect(publish).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('para no primeiro job que não publica e deixa os demais pending', async () => {
    lockFor.mockResolvedValue([
      pendingJob('a'),
      pendingJob('b'),
      pendingJob('c'),
    ]);
    publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Fila indisponível'));

    await expect(publisher.publishPending()).resolves.toBe(1);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('não marca published quando o broker rejeita a mensagem', async () => {
    lockFor.mockResolvedValue([pendingJob('a')]);
    publish.mockRejectedValue(new Error('nack do broker'));

    await expect(publisher.publishPending()).resolves.toBe(0);

    expect(tx.update).not.toHaveBeenCalled();
  });

  it('o laço publica em segundo plano e para no shutdown', async () => {
    lockFor.mockResolvedValue([pendingJob('a')]);

    publisher.onApplicationBootstrap();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await publisher.beforeApplicationShutdown();

    const calls = transaction.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transaction.mock.calls.length).toBe(calls);
  });

  it('o laço sobrevive a uma falha do banco e tenta de novo', async () => {
    transaction.mockRejectedValueOnce(new Error('db fora do ar'));
    lockFor.mockResolvedValue([]);

    publisher.onApplicationBootstrap();
    await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(1));
    await publisher.beforeApplicationShutdown();

    expect(transaction).toHaveBeenCalled();
  });
});
