# Instruções para GitHub Copilot

Este repositório é um mini app de pedidos em **Node.js + NestJS (Fastify) + Drizzle ORM (MariaDB) + RabbitMQ (amqplib) + Zod (`nestjs-zod`)**.

As regras completas e obrigatórias estão em [`AGENTS.md`](../AGENTS.md); detalhes técnicos em [`docs/ai/`](../docs/ai/). Resumo:

- Use Node.js 24 (LTS) e Yarn 4 (`yarn install`, `yarn <script>`), nunca Bun/npm/pnpm. Adaptador HTTP: `@nestjs/platform-fastify`, nunca Express.
- Controllers finos; regra de negócio em services; banco via `@Inject(DRIZZLE)`.
- Validação de entrada e saída com Zod (`createZodDto`, `ZodValidationPipe`, `@ZodSerializerDto`). Sem `class-validator`.
- Variáveis de ambiente em `src/config/env.ts` com valor padrão, sem validação.
- Todas as funções, métodos, classes e interfaces têm Docblock (`/** */`) com `@param`, `@returns` e `@throws`. Sem comentários `//` óbvios.
- Jobs em `src/jobs/*.job.ts` com `@Job({ queue, name })`; logs do worker: 📥 Recebido -> ⚙️ Processando -> ✅ Concluído.
- Altere apenas o trecho necessário; não reescreva arquivos inteiros.
