# Receitas de trabalho

## Criar um novo módulo de domínio (ex.: `payments`)

1. Crie `src/payments/` com `payments.module.ts`, `payments.controller.ts`, `payments.service.ts`, `payment.schema.ts`.
2. Defina schemas Zod e DTOs (`createZodDto`) em `payment.schema.ts`.
3. Controller fino com `@ZodSerializerDto(...)` nas rotas; regra de negócio no service.
4. Importe `PaymentsModule` em `AppModule.imports`.
5. Se precisar de tabela: edite `src/database/schema.ts` e rode `yarn migration:generate <nome>`.

## Criar uma rota

1. Schemas de `params`/`query`/`body`/`response` no `*.schema.ts` do módulo.
2. Handler com `@Get/@Post/...`, DTOs nos `@Body/@Param/@Query`, `@ZodSerializerDto` e `@HttpCode` quando o status não for o padrão.
3. Delegue ao service. Documente com Docblock.

## Criar um job

1. `src/jobs/<nome>.job.ts` com classe `@Injectable() @Job({ queue, name })` implementando `JobHandler<Payload>`.
2. Registre a classe em `providers` de um módulo.
3. Dispare com `this.queue.dispatch(NomeJob, payload)`.
4. Logs: 📥 (feito pelo `QueueService`), ⚙️ e ✅ no `handle`.

## Criar uma migration

```bash
yarn migration:generate create_payments_table
yarn migrate:up
yarn migrate:down --step=1
yarn migrate:fresh
```

Revise o `up` e o `down` gerados antes de aplicar.

## Rodar localmente

```bash
cp .env.example .env
docker compose up -d mariadb rabbitmq
yarn install
yarn migrate:up
yarn start:dev
```

Ou tudo em Docker: `docker compose up -d --build && docker compose logs -f app`.

Teste rápido:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"customer_email":"a@b.com","product":"Livro","amount":49.9}'
```

Esperado: `201` com `{ id, customer_email, product, amount }` e, nos logs, 📥 -> ⚙️ -> ✅.

## Checklist antes de concluir qualquer tarefa

- [ ] `yarn build` e `yarn lint` sem erros; `yarn format` aplicado.
- [ ] `yarn test` (e `yarn test:e2e`, se tocou em rotas) passando.
- [ ] Docblocks completos em tudo que foi criado/alterado; nenhum comentário inline óbvio.
- [ ] Rotas com schemas Zod de entrada e saída; sem validação manual no handler.
- [ ] Nenhum `any`, `console.log`, `class-validator` ou import de Bun/Express.
- [ ] Variáveis novas em `env.ts` com valor padrão (e em `.env.example`/compose se necessário).
- [ ] Apenas o trecho necessário foi alterado.
