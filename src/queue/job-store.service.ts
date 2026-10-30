import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { JOB_STATUS } from '../database/schema.js';
import { Job, type JobHandler, type JobOptions } from './job.decorator.js';
import { JOB_LEASE_MS } from './queue.config.js';

/**
 * Executor capaz de inserir linhas: o próprio Drizzle ou uma transação dele.
 */
export type InsertExecutor = Pick<MySql2Database<typeof schema>, 'insert'>;

/**
 * Resultado de tentar reivindicar um job para execução:
 * - `claimed`: este worker passa a ser o dono da execução;
 * - `finished`: o job já terminou (`done` ou `failed`), a mensagem é duplicata;
 * - `busy`: outro worker o executa agora (dentro do lease);
 * - `missing`: não há registro do job (por exemplo, já apagado pela limpeza).
 */
export type ClaimResult = 'claimed' | 'finished' | 'busy' | 'missing';

/**
 * Persiste e transiciona o ciclo de vida dos jobs na tabela `jobs`. Todas as transições são updates
 * condicionais, o que torna a execução idempotente mesmo com entregas duplicadas ou simultâneas.
 */
@Injectable()
export class JobStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Grava um job `pending` (outbox). Deve receber a transação do dado de negócio, para que ambos sejam
   * confirmados ou desfeitos juntos; o publicador o envia à fila depois.
   *
   * @param executor - Transação (ou Drizzle) onde a linha é inserida.
   * @param job - Classe do job, decorada com `@Job()`.
   * @param payload - Dados entregues ao `handle` do job.
   * @returns Id do job, que viaja na mensagem como `messageId`.
   * @throws Error se a classe não estiver decorada com `@Job()`; erro do driver se o insert falhar.
   */
  async enqueue<TPayload>(
    executor: InsertExecutor,
    job: Type<JobHandler<TPayload>>,
    payload: TPayload,
  ): Promise<string> {
    const options = this.reflector.get<JobOptions | undefined>(Job.KEY, job);
    if (!options) {
      throw new Error(`Classe ${job.name} não está decorada com @Job()`);
    }

    const id = randomUUID();
    await executor.insert(schema.jobs).values({
      id,
      queue: options.queue,
      name: options.name,
      payload,
      createdAt: new Date(),
    });
    return id;
  }

  /**
   * Reivindica o job para execução: só passa a `processing` se ainda não foi executado ou se o lease de
   * uma execução anterior expirou. Cada reivindicação incrementa `attempts`.
   *
   * @param id - Id do job (o `messageId` da mensagem).
   * @returns Se o job foi reivindicado e, se não, por que não.
   * @throws Erro do driver se a consulta falhar.
   */
  async claim(id: string): Promise<ClaimResult> {
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - JOB_LEASE_MS);

    const [result] = await this.db
      .update(schema.jobs)
      .set({
        status: JOB_STATUS.processing,
        startedAt: now,
        attempts: sql`${schema.jobs.attempts} + 1`,
      })
      .where(
        and(
          eq(schema.jobs.id, id),
          or(
            inArray(schema.jobs.status, [
              JOB_STATUS.pending,
              JOB_STATUS.published,
            ]),
            and(
              eq(schema.jobs.status, JOB_STATUS.processing),
              lt(schema.jobs.startedAt, leaseCutoff),
            ),
          ),
        ),
      );
    if (result.affectedRows > 0) return 'claimed';

    const [row] = await this.db
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, id));
    if (!row) return 'missing';
    return row.status === JOB_STATUS.processing ? 'busy' : 'finished';
  }

  /**
   * Marca o job como concluído.
   *
   * @param id - Id do job.
   * @returns Promise resolvida quando o registro for atualizado.
   * @throws Erro do driver se o update falhar.
   */
  async complete(id: string): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status: JOB_STATUS.done, finishedAt: new Date(), lastError: null })
      .where(eq(schema.jobs.id, id));
  }

  /**
   * Devolve o job a `published` depois de uma falha com tentativas restantes, guardando o erro, para
   * que a mensagem reenviada à fila de retry possa reivindicá-lo de novo.
   *
   * @param id - Id do job.
   * @param error - Erro da execução que falhou.
   * @returns Promise resolvida quando o registro for atualizado.
   * @throws Erro do driver se o update falhar.
   */
  async release(id: string, error: unknown): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status: JOB_STATUS.published, lastError: this.describe(error) })
      .where(eq(schema.jobs.id, id));
  }

  /**
   * Marca o job como falho (foi para a DLQ), guardando o erro. Jobs já concluídos não são alterados.
   *
   * @param id - Id do job.
   * @param error - Motivo da falha.
   * @returns Promise resolvida quando o registro for atualizado.
   * @throws Erro do driver se o update falhar.
   */
  async fail(id: string, error: unknown): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({
        status: JOB_STATUS.failed,
        finishedAt: new Date(),
        lastError: this.describe(error),
      })
      .where(
        and(eq(schema.jobs.id, id), ne(schema.jobs.status, JOB_STATUS.done)),
      );
  }

  /**
   * Apaga os jobs `done` terminados antes da data de corte. Jobs `failed` são preservados para auditoria.
   *
   * @param olderThan - Data de corte.
   * @returns Quantidade de linhas apagadas.
   * @throws Erro do driver se o delete falhar.
   */
  async purgeDone(olderThan: Date): Promise<number> {
    const [result] = await this.db
      .delete(schema.jobs)
      .where(
        and(
          eq(schema.jobs.status, JOB_STATUS.done),
          lt(schema.jobs.finishedAt, olderThan),
        ),
      );
    return result.affectedRows;
  }

  /**
   * Extrai uma descrição curta de um erro desconhecido.
   *
   * @param error - Valor capturado em um `catch`.
   * @returns Mensagem do erro, ou o valor convertido para texto.
   */
  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
