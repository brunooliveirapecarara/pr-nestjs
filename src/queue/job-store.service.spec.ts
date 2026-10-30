import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DRIZZLE } from '../database/database.constants.js';
import { jobs } from '../database/schema.js';
import { Job, type JobHandler } from './job.decorator.js';
import { JobStore } from './job-store.service.js';

/**
 * Job de teste decorado com `@Job()`.
 */
@Injectable()
@Job({ queue: 'q', name: 'sample' })
class SampleJob implements JobHandler<{ id: number }> {
  async handle(): Promise<void> {}
}

/**
 * Classe sem `@Job()`.
 */
class PlainJob implements JobHandler<number> {
  async handle(): Promise<void> {}
}

describe('JobStore', () => {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const selectWhere = vi.fn();
  const select = vi.fn(() => ({ from: () => ({ where: selectWhere }) }));
  const deleteWhere = vi.fn();
  const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
  let store: JobStore;

  /**
   * Resultado de um update/delete do mysql2.
   *
   * @param affectedRows - Linhas afetadas.
   * @returns Tupla no formato devolvido pelo Drizzle.
   */
  const affected = (affectedRows: number): [{ affectedRows: number }] => [
    { affectedRows },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        JobStore,
        {
          provide: DRIZZLE,
          useValue: { update, select, delete: deleteFrom },
        },
      ],
    }).compile();
    store = moduleRef.get(JobStore);
  });

  describe('enqueue', () => {
    it('insere o job pending com fila e nome lidos do @Job() e devolve o id', async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      const insert = vi.fn(() => ({ values }));

      const id = await store.enqueue({ insert }, SampleJob, { id: 1 });

      expect(insert).toHaveBeenCalledWith(jobs);
      expect(values).toHaveBeenCalledWith({
        id,
        queue: 'q',
        name: 'sample',
        payload: { id: 1 },
        createdAt: expect.any(Date),
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('falha se a classe não está decorada com @Job()', async () => {
      const insert = vi.fn();

      await expect(store.enqueue({ insert }, PlainJob, 1)).rejects.toThrow(
        'não está decorada com @Job()',
      );
      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('claim', () => {
    it('devolve claimed e incrementa attempts quando reivindica', async () => {
      where.mockResolvedValue(affected(1));

      await expect(store.claim('id-1')).resolves.toBe('claimed');

      const [values] = set.mock.calls[0] as unknown as [
        { status: string; startedAt: Date; attempts: unknown },
      ];
      expect(values.status).toBe('processing');
      expect(values.startedAt).toBeInstanceOf(Date);
      expect(values.attempts).toBeDefined();
      expect(select).not.toHaveBeenCalled();
    });

    it.each([
      ['done', 'finished'],
      ['failed', 'finished'],
      ['processing', 'busy'],
    ])('com o job em %s devolve %s', async (status, expected) => {
      where.mockResolvedValue(affected(0));
      selectWhere.mockResolvedValue([{ status }]);

      await expect(store.claim('id-1')).resolves.toBe(expected);
    });

    it('devolve missing quando não há registro', async () => {
      where.mockResolvedValue(affected(0));
      selectWhere.mockResolvedValue([]);

      await expect(store.claim('id-1')).resolves.toBe('missing');
    });

    it('propaga o erro do banco', async () => {
      where.mockRejectedValue(new Error('db fora do ar'));

      await expect(store.claim('id-1')).rejects.toThrow('db fora do ar');
    });
  });

  describe('transições', () => {
    beforeEach(() => where.mockResolvedValue(affected(1)));

    it('complete marca done com finishedAt e limpa o erro', async () => {
      await store.complete('id-1');

      expect(set).toHaveBeenCalledWith({
        status: 'done',
        finishedAt: expect.any(Date),
        lastError: null,
      });
    });

    it('release volta a published guardando o erro', async () => {
      await store.release('id-1', new Error('boom'));

      expect(set).toHaveBeenCalledWith({
        status: 'published',
        lastError: 'boom',
      });
    });

    it('fail marca failed com o erro e finishedAt', async () => {
      await store.fail('id-1', 'texto');

      expect(set).toHaveBeenCalledWith({
        status: 'failed',
        finishedAt: expect.any(Date),
        lastError: 'texto',
      });
    });

    it('purgeDone devolve quantas linhas apagou', async () => {
      deleteWhere.mockResolvedValue(affected(3));

      await expect(store.purgeDone(new Date())).resolves.toBe(3);
    });
  });
});
