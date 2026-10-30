# Estilo de código

## Docblocks (obrigatório)

Toda função, método, classe, interface, DTO e hook de ciclo de vida tem Docblock `/** ... */` com:

1. Descrição clara e sucinta.
2. `@param nome - descrição` para cada argumento (tipo vem do TS, descreva o significado).
3. `@returns` com o significado do retorno.
4. `@throws` quando aplicável.

Classes e interfaces sem parâmetros levam apenas a descrição. Construtores com injeção por parâmetro de construtor dispensam `@param` quando o nome do provider é autoexplicativo.

## Comentários

Proibido `//` que apenas narra o óbvio (`// Salva no banco`). Se precisar explicar, renomeie ou extraia função. Comentário só para o "porquê" não óbvio.

## Nomenclatura

| Item | Padrão | Exemplo |
| --- | --- | --- |
| Arquivos | `kebab-case` + sufixo Nest | `orders.service.ts`, `process-order.job.ts`, `order.schema.ts` |
| Classes | `PascalCase` + sufixo | `OrdersController`, `ProcessOrderJob`, `CreateOrderDto` |
| Schemas Zod | `camelCase` + `Schema` | `createOrderSchema` |
| Tokens DI | `SCREAMING_SNAKE` (`Symbol`) | `DRIZZLE` |
| Payload HTTP | `snake_case` | `customer_email` |
| Código interno / colunas TS | `camelCase` | `customerEmail` |
| Filas/jobs | `snake_case` | `order_processing`, `process_order` |

## TypeScript

- `strict: true`; sem `any` (exceção: registry genérico de jobs, comentado por Docblock).
- Retorno explícito em métodos públicos; `readonly` em dependências injetadas.
- `import type` para tipos puros; import normal para classes injetadas (metadados de decorator).
- Idioma: Docblocks, mensagens de log e commits em **português**; identificadores em **inglês**.

## Idioma e logs

Use `Logger` do Nest. Emojis do ciclo de vida são parte do contrato: 🐇 conexão, 👷 worker, 📥 recebido, ⚙️ processando, ✅ concluído, ❌ falha, 🚀 servidor.

## Commits

Conventional Commits em português ou inglês consistente com o histórico: `feat(orders): ...`, `fix(queue): ...`, `chore(git): ...`. Só faça commit quando o usuário pedir.

## Edição

Altere apenas o trecho necessário. Não reescreva arquivos inteiros sem solicitação.
