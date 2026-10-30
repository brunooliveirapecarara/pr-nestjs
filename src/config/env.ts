/**
 * Configuração da aplicação lida direto do `process.env`, com valor padrão para cada variável.
 */
export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  DB_HOST: process.env.DB_HOST ?? 'localhost',
  DB_PORT: Number(process.env.DB_PORT ?? 3306),
  DB_USER: process.env.DB_USER ?? 'root',
  DB_PASSWORD: process.env.DB_PASSWORD ?? 'secret123',
  DB_NAME: process.env.DB_NAME ?? 'orders_db',
  RABBITMQ_URL: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
};
