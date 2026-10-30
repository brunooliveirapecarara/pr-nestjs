import { DiscoveryService } from '@nestjs/core';

/**
 * Tentativas extras padrão de um job que falha (sem retry).
 */
export const DEFAULT_JOB_RETRIES = 0;

/**
 * Atraso padrão, em milissegundos, entre uma falha e a nova tentativa.
 */
export const DEFAULT_JOB_BACKOFF_MS = 5000;

/**
 * Metadados de um job: fila onde roda, seu nome e a política de retry.
 */
export interface JobOptions {
  queue: string;
  name: string;
  /** Quantas vezes reexecutar após uma falha, antes de enviar à DLQ. Padrão: 0. */
  retries?: number;
  /** Atraso em ms antes de cada nova tentativa. Padrão: 5000. */
  backoffMs?: number;
}

/**
 * Contrato implementado por toda classe de job.
 */
export interface JobHandler<TPayload> {
  /**
   * Executa o job a partir do payload recebido da fila.
   *
   * @param payload - Dados deserializados da mensagem.
   * @returns Promise resolvida quando o processamento terminar.
   */
  handle(payload: TPayload): Promise<void>;
}

/**
 * Marca uma classe `@Injectable()` como job de uma fila. Criado por `DiscoveryService.createDecorator`,
 * o que permite ao `DiscoveryService` encontrar as classes decoradas (`Job.KEY` é a chave dos metadados).
 *
 * @param options - Fila e nome do job.
 * @returns Decorator de classe que grava os metadados.
 */
export const Job = DiscoveryService.createDecorator<JobOptions>();
