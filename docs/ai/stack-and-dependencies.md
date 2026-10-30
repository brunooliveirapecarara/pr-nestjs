# Stack, dependências e ferramentas

## Runtime e ferramentas

| Ferramenta | Uso |
| --- | --- |
| Node.js 24 (LTS) | Runtime. Proibido Bun. |
| Yarn (`yarn.lock`) | Gerenciador de pacotes e executor de scripts. Proibido npm/pnpm/bun. |
| NestJS 12 (ESM) | App com `"type": "module"`; imports relativos levam extensão `.js`. |
| NestJS CLI (`@nestjs/cli`) | `nest build` (limpa `dist/`), `nest start --watch` e scaffolding (`yarn nest g module orders`). Config em `nest-cli.json`. |
| TypeScript 6 | `strict: true`, `module`/`moduleResolution` `nodenext`, `experimentalDecorators` e `emitDecoratorMetadata` obrigatórios para a DI. |
| Vitest 4 (+ Vite 8) | Testes unitários (`*.spec.ts`) e e2e (`test/*.e2e-spec.ts`). Configs: `vitest.config.ts` e `vitest.config.e2e.ts` (`resolve.tsconfigPaths`, `globals: true`). |
| oxlint (+ `oxlint-tsgolint`) | Lint com checagem de tipos (`yarn lint`); `typescript/no-floating-promises` como erro. |
| Prettier | Formatação (`yarn format`): `singleQuote: true`, `trailingComma: "all"`. |
| drizzle-kit | Somente utilitário de tipos/config; as migrations são geradas pelo script próprio `migration:generate`. |
| Docker Compose | MariaDB 11, RabbitMQ 4 (management) e o serviço `app`. |

## Dependências de runtime (`dependencies`)

Já presentes no app:

| Pacote | Função |
| --- | --- |
| `@nestjs/common` | Decorators (`@Controller`, `@Injectable`, `@Module`, `@Body`...), `Logger`, exceções HTTP. |
| `@nestjs/core` | `NestFactory`, `DiscoveryService`, `Reflector`, `APP_PIPE`/`APP_INTERCEPTOR`. |
| `@nestjs/platform-fastify` | Adaptador HTTP (`FastifyAdapter`) usado pelo `NestFactory.create`. |
| `reflect-metadata` | Metadados de decorators (o `@nestjs/core` já o carrega; não importe no `main.ts`). |
| `rxjs` | Peer dependency do Nest (interceptors, `Observable`). |

A adicionar:

| Pacote | Função |
| --- | --- |
| `drizzle-orm` | ORM (dialeto `mysql2`). |
| `mysql2` | Driver/pool de conexão do MariaDB. |
| `amqplib` | Cliente RabbitMQ. |
| `zod` (v4) | Schemas de entrada e saída. |
| `nestjs-zod` | Integra Zod ao Nest: `createZodDto`, `ZodValidationPipe`, `ZodSerializerInterceptor`, `@ZodSerializerDto`. |

> **`nestjs-zod`:** até a 5.5.0 o peer dep é `@nestjs/common ^10 || ^11` (sem declarar o Nest 12). Espere aviso do Yarn; se o pacote funcionar no Nest 12, silencie com `packageExtensions` no `.yarnrc.yml` e valide `createZodDto`, `ZodValidationPipe` e `ZodSerializerInterceptor` com testes antes de confiar nele.

## Dependências de desenvolvimento (`devDependencies`)

Já presentes no app (template do Nest 12):

| Pacote | Função |
| --- | --- |
| `typescript`, `@types/node` | Compilador e tipos do Node. |
| `@nestjs/cli`, `@nestjs/schematics` | Build, `nest start` e geradores `nest g`. |
| `@nestjs/testing` | `Test.createTestingModule` para testes. |
| `vitest`, `vite`, `@vitest/coverage-v8` | Runner de testes, bundler e cobertura. |
| `supertest`, `@types/supertest` | Testes e2e HTTP. |
| `oxlint`, `oxlint-tsgolint`, `prettier` | Lint e formatação. |
| `source-map-support` | Stack traces com source map. |
| `@nestjs/mau` | Deploy (`yarn deploy`), vindo do template. |
| `@types/express` | Vem do template; o adaptador é Fastify, então pode ser removido. |

A adicionar: `@types/amqplib` (se a versão instalada não trouxer tipos) e `drizzle-kit`.

## Instalação (referência)

```bash
yarn add drizzle-orm mysql2 amqplib zod nestjs-zod
yarn add -D @types/amqplib drizzle-kit
```

Confirme as versões compatíveis entre si (Nest 12, Zod 4, `nestjs-zod` com suporte a Zod 4) antes de fixar no `package.json`.

## `package.json` — scripts

Scripts existentes no app: `build`, `deploy`, `format`, `start`, `start:dev`, `start:debug`, `start:prod` (`node dist/main`), `lint`, `test`, `test:watch`, `test:cov`, `test:debug` e `test:e2e`. Scripts a adicionar para as migrations:

```json
{
  "scripts": {
    "migration:generate": "nest build && node dist/database/migration-generate.js",
    "migrate:up": "nest build && node dist/database/migrate-up.js",
    "migrate:down": "nest build && node dist/database/migrate-down.js",
    "migrate:fresh": "nest build && node dist/database/migrate-fresh.js"
  }
}
```

Os scripts de migration rodam compilados (`nest build` -> `dist/`), sem dependência extra de execução de TypeScript; não precisam de decorators. `migration-generate` lê `schema.ts`/snapshot e escreve os `.ts` em `src/database/migrations/` (caminho a partir da raiz do projeto), enquanto `migrate-*` carregam os `.js` compilados em `dist/database/migrations/`. Argumentos passam direto: `yarn migrate:down --step=2`.

## `tsconfig.json` — pontos críticos

`tsconfig.json` do app (`tsconfig.build.json` estende-o, com `rootDir: ./src` e exclui `test` e `*spec.ts`):

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "resolvePackageJsonExports": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": ".",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "types": ["vitest/globals", "node"]
  }
}
```

O `nest build` (tsc) emite o decorator metadata, então a injeção por tipo de construtor funciona. Com `isolatedModules` e `emitDecoratorMetadata`, importe com import normal (não `import type`) tudo que for injetado no construtor, senão o metadado é perdido. Nos testes, o Vitest não usa o `tsc`: se a DI por tipo falhar, registre um plugin SWC (`unplugin-swc` com `decoratorMetadata`) ou injete via `@Inject(Classe)`.

## Variáveis de ambiente (mesmas do projeto original)

| Variável | Padrão |
| --- | --- |
| `PORT` | `3000` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_USER` | `root` |
| `DB_PASSWORD` | `secret123` |
| `DB_NAME` | `orders_db` |
| `RABBITMQ_URL` | `amqp://localhost:5672` |

## Infra (Docker)

- `docker-compose.yml` com serviços `mariadb` (11), `rabbitmq` (4-management, painel `:15672`) e `app` (`depends_on` com `service_healthy`).
- `Dockerfile` multi-stage baseado em `node:24-alpine`: copia `package.json` + `yarn.lock`, roda `yarn install --immutable` e `yarn build`; a imagem final leva só dependências de produção e `dist/`, e inicia com um entrypoint que executa `node dist/database/migrate-up.js` antes de `node dist/main`.
- `.env.example` com `DB_PASSWORD` e `DB_NAME` (lidos pelo compose).
