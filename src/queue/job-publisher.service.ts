import { setTimeout as sleep } from 'node:timers/promises';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { DRIZZLE } from '../database/database.constants.js';
import * as schema from '../database/schema.js';
import { JOB_STATUS } from '../database/schema.js';
import { JobStore } from './job-store.service.js';
import {
  JOB_PUBLISH_BATCH_SIZE,
  JOB_PUBLISH_INTERVAL_MS,
  JOB_PURGE_EVERY_SWEEPS,
  JOB_RETENTION_MS,
} from './queue.config.js';
import { QueueService } from './queue.service.js';

/**
 * Publicador do outbox: varre a tabela `jobs` em segundo plano, publica na fila os jobs `pending` (com
 * confirmação do broker) e os marca como `published`. Várias réplicas podem rodar juntas: a varredura usa
 * `FOR UPDATE SKIP LOCKED`, então cada job é pego por uma só.
 */
@Injectable()
export class JobPublisher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(JobPublisher.name);
  private readonly stop = new AbortController();
  private loop: Promise<void> | null = null;
  private sweeps = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: MySql2Database<typeof schema>,
    private readonly queue: QueueService,
    private readonly store: JobStore,
  ) {}

  /**
   * Inicia a varredura periódica, depois que a fila já conectou (`QueueService.onModuleInit`).
   *
   * @returns Nada; a varredura segue em segundo plano.
   */
  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  /**
   * Para a varredura e espera a que estiver em andamento terminar, antes de a fila ser fechada.
   *
   * @returns Promise resolvida quando a varredura parar.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.loop;
  }

  /**
   * Publica os jobs `pending` mais antigos, em uma transação que trava as linhas com `SKIP LOCKED`.
   * Para no primeiro job que não conseguir publicar; ele e os seguintes continuam `pending`.
   *
   * @returns Quantidade de jobs publicados nesta varredura.
   * @throws Erro do driver se a transação falhar.
   */
  async publishPending(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const pending = await tx
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.status, JOB_STATUS.pending))
        .orderBy(asc(schema.jobs.createdAt))
        .limit(JOB_PUBLISH_BATCH_SIZE)
        .for('update', { skipLocked: true });

      let published = 0;
      for (const job of pending) {
        try {
          await this.queue.publish(job.queue, job.name, job.payload, job.id);
        } catch (error) {
          this.logger.warn(
            `⚠️ Job ${job.id} (${job.queue}/${job.name}) não publicado: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          break;
        }

        await tx
          .update(schema.jobs)
          .set({ status: JOB_STATUS.published, publishedAt: new Date() })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, JOB_STATUS.pending),
            ),
          );
        published++;
      }
      return published;
    });
  }

  /**
   * Laço da varredura: publica, apaga periodicamente os `done` vencidos e dorme até a próxima rodada.
   * Falhas (banco ou fila indisponíveis) são registradas e a varredura tenta de novo na rodada seguinte.
   *
   * @returns Promise resolvida quando o laço for interrompido.
   */
  private async run(): Promise<void> {
    while (!this.stop.signal.aborted) {
      try {
        const published = await this.publishPending();
        if (published > 0) {
          this.logger.log(`📤 ${published} job(s) publicado(s) na fila`);
        }
        if (++this.sweeps % JOB_PURGE_EVERY_SWEEPS === 0) {
          await this.store.purgeDone(new Date(Date.now() - JOB_RETENTION_MS));
        }
      } catch (error) {
        this.logger.warn(
          `⚠️ Varredura da tabela jobs falhou: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      try {
        await sleep(JOB_PUBLISH_INTERVAL_MS, undefined, {
          signal: this.stop.signal,
        });
      } catch {
        return;
      }
    }
  }
}
