/**
 * Concorrência padrão de uma fila sem configuração própria: uma mensagem por vez.
 */
export const DEFAULT_QUEUE_CONCURRENCY = 1;

/**
 * Número máximo de mensagens processadas em paralelo por fila (`prefetch` do canal consumidor).
 * Filas ausentes usam `DEFAULT_QUEUE_CONCURRENCY`.
 */
export const QUEUE_CONCURRENCY: Readonly<Record<string, number>> = {
  order_processing: 1,
};

/**
 * Retentativas de conexão com o RabbitMQ no boot antes de derrubar a aplicação. Depois de conectada,
 * a reconexão é ilimitada (backoff exponencial do próprio amqplib).
 */
export const RABBITMQ_INITIAL_CONNECT_RETRIES = 5;
