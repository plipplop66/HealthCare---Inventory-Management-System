# MEDRIPPLE deployment

MEDRIPPLE is deployed on **Vercel and Supabase PostgreSQL**.

| Task | Document |
| --- | --- |
| Current status and release candidate | [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) |
| Set up Vercel and Supabase | [VERCEL-SUPABASE-DEPLOYMENT.md](VERCEL-SUPABASE-DEPLOYMENT.md) |
| Release to the existing deployment (backup, migration 005, deployment order, smoke tests, rollback) | [docs/release-checklist.md](docs/release-checklist.md) |
| Current services and configuration | [docs/vercel-supabase.md](docs/vercel-supabase.md) |
| Docker host with MySQL | [docs/deployment.md](docs/deployment.md) |
| Local development | [QUICK-START.md](QUICK-START.md) |

`railway.toml`, `Dockerfile.railway` and `railway-start.sh` remain from an abandoned Railway trial. They are not maintained or verified; do not use them for a release.

All data is simulated. Plans are decision support, and stock moves only after a human approval.
