# AWS cost design

Goal: the lowest possible monthly bill for a single-tenant ERP with light,
intermittent use, without giving up Postgres semantics or managed
infrastructure. Every choice below is reflected in `amplify/backend.ts`.

## Architecture on AWS

| Concern | Service | Why this and not the alternative |
|---|---|---|
| Web + API | **Amplify Hosting** (Next.js SSR) | The ORM runs inside Next.js route handlers on Hosting's Lambda-backed compute. No AppSync ($4/M queries), no separate API Gateway + Lambda, no second deployment. |
| Database | **Aurora PostgreSQL Serverless v2**, min **0 ACU**, max 2 ACU, auto-pause after 10 min | Scale-to-zero means idle time costs storage only. A `db.t4g.micro` RDS is ~$12/mo *always*, and needs the app inside a VPC to reach it. |
| DB connectivity | **RDS Data API** (HTTPS + IAM) | Removes the VPC from the application tier entirely: no NAT Gateway (~$32/mo), no RDS Proxy (~$11/mo), no VPC cold-start penalty. The DB's VPC has only isolated subnets, which are free. |
| Auth | **Cognito** user pool, invitation-only | Free up to 10,000 MAU. Advanced security features off (they are the paid tier). |
| Files | **S3** | Attachments, avatars, PDFs, documents. Cents per GB; lifecycle rules can tier old reports to Infrequent Access. |
| Email | **SES** | $0.10 per 1,000 emails after the free tier. |
| Scheduled jobs | **EventBridge Scheduler → Lambda** | 14M invocations/month free; Lambda free tier covers the cron workload. |
| Realtime (Discuss, presence) | **AppSync Events** (planned) | $1/M messages + $0.08/M connection-minutes; far cheaper than a persistent WebSocket server. |
| Search | Postgres `ILIKE` / trigram | No OpenSearch (≥ $25/mo minimum). |
| PDF | Lambda + headless Chromium | Pay per render only. |

## What the idle bill looks like

With nobody using the system for a month:

| Item | Estimate |
|---|---|
| Aurora storage (few GB) | ~$0.30–1.00 |
| Aurora backups (1 day retention, non-prod) | ~$0 (within free backup storage) |
| S3 (few hundred MB) | ~$0.01 |
| Cognito, Lambda, EventBridge, SES | $0 (free tiers) |
| Amplify Hosting | build minutes only when you deploy ($0.01/min) |
| Secrets Manager (DB secret) | ~$0.40 |
| **Total** | **≈ $1–2 / month** |

## What active use costs

- Aurora: **$0.12 per ACU-hour** (us-east-1). At 0.5 ACU for 8 working hours a
  day, 22 days: ~$10/month. At 2 ACU sustained: ~$175/month, which is why
  the max is capped at 2 — raise it only when needed.
- Amplify SSR compute: $0.30 per million requests + $0.20 per GB-hour of
  memory-time. A busy internal team is a few dollars.
- Data API: $0.35 per million requests (each ORM query is one request).
- Data transfer out: $0.15/GB after 100 GB free.

Rule of thumb: a small company using it daily lands around **$10–25/month**,
dominated by Aurora compute hours.

## Trade-offs accepted

- **Resume latency**: the first request after an auto-pause takes ~15 s
  while Aurora resumes. The app shows the loading bar; nothing breaks. If
  that becomes annoying, set `serverlessV2MinCapacity: 0.5` (~$43/mo) in
  `amplify/database/aurora.ts`.
- **No RDS Proxy**: the Data API does its own pooling; Lambda concurrency is
  low for this workload.
- **PGlite for development**: `npm run dev` with no `DATABASE_URL` runs an
  in-process Postgres in `.pglite/`, so local development costs nothing and
  needs no Docker or server.

## Deploying

1. Push to `main` with Amplify Hosting connected (or `npx ampx sandbox
   --profile <profile>` for a personal cloud sandbox). The backend phase
   creates Cognito, S3, the Aurora cluster and writes their details into
   `amplify_outputs.json`; the app reads the cluster ARN/secret from that
   file, so no environment variables are needed.
2. One console step, once per app: **App settings → IAM roles → Compute
   role** → select `rodeo-compute-<stack>` (its ARN is printed in
   `amplify_outputs.json` → `custom.database.computeRoleArn`). That role
   carries the Data API + secret permissions.
3. Set `RODEO_SESSION_SECRET` (any long random string) in **App settings →
   Environment variables** so local sessions are signed with a private key.
4. The first request syncs the schema and loads the seed; both are
   idempotent. Aurora takes ~15 s to resume from a pause on that first hit.
