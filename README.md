# Rodeo ERP

A metadata-driven clone of Odoo 19.4 Enterprise (22 apps, EN/AR) on AWS
Amplify Gen 2 + Next.js, built for the lowest possible AWS bill.

- Spec: `ODOO_CLONE_MASTER_PROMPT_1.md` (prose parts in `docs/spec/`)
- Machine-readable capture of the live instance: `registry/odoo_spec.json`
- Status and roadmap: `BUILD.md` · Cost design: `docs/COST.md`

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000 — uses an in-process Postgres (.pglite/)
```

Log in with the seeded admin (`mastaisshakh@gmail.com`); the first login sets
the password. Language switch is in the user menu.

```bash
npm test               # engine, ORM, seed and app tests (in-process Postgres)
npm run typecheck
npm run generate:registry   # registry/generated/*.json + messages/{en,ar}.json
npm run db:shell -- "SELECT count(*) FROM sale_order"
```

## Deploy

`npx ampx sandbox` for a personal cloud sandbox, or connect the repo to
Amplify Hosting. See `docs/COST.md` → Deploying for the two console steps.
