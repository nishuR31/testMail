# Mailbench

A small test suite for email delivery, in two modes, over **EmailJS** and **Resend**:

| Mode | What happens |
|---|---|
| **Direct** | The request calls the provider immediately. No throttling, retries or failover. This is the baseline. |
| **Queued** | Jobs go to **BullMQ on Redis (Upstash)**: one queue + worker per provider, per-provider rate limits, retries with exponential back-off, honours `429 Retry-After`, and **load balancing**. |

Dark theme by default, Lucide icons, Tailwind v4 (browser build: no PostCSS, no config file). Vanilla JS modules, no bundler.

## Run

```bash
npm install
cp .env.example .env      # fill in what you have; every provider is optional
npm run dev               # http://localhost:3000
npm test
```
Needs Node 22+. **It cannot run on Cloudflare Pages/Workers:** BullMQ needs a persistent worker and TCP Redis.
Use any Node host (Railway, Render, Fly, a VPS, Docker: `docker build -t mailbench .`).
Split web and worker: `RUN_WORKER=false` on the web process and `npm run worker` as a second process.

## UI features

- **Mobile**: bottom tab bar (Compose / Dashboard / Activity) with a live pending badge; no horizontal overflow at 390px.
- **Compose**: burst presets (1/5/10/25/50/100), sample fill, clear form, `Ctrl+Enter` to send, **Copy as cURL**.
- **A/B benchmark**: sends the same burst Direct, then Queued, and compares wall time and delivered/failed counts.
  It refuses to start while queues are busy so the numbers are clean, and asks to confirm before using real quota.
- **Dashboard**: per-provider share bar of queued deliveries, ETA per queue, quota bars.
- **Activity**: search, mode/problem filters, **CSV export** (formula-safe cells).
- **Setup guide** (book icon): shows which of Redis, Resend, EmailJS and the simulators are configured, with a copyable minimal `.env`.

## Load balancing
Each email is assigned to the selected provider with the smallest estimated wait, `(pending + 1) / requests-per-second`.
An idle provider takes the next job, a backed-up one is skipped, providers out of free-tier quota are skipped, and a job that fails permanently on one provider is **failed over** to another selected provider.

## Upstash notes
- Use the **TCP** endpoint `rediss://default:<password>@<db>.upstash.io:6379`. The REST url/token pair is for HTTP clients. If you only have REST values, `UPSTASH_REDIS_REST_URL` + `_TOKEN` are converted automatically.
- Upstash bills per command. Workers long-poll with `QUEUE_DRAIN_DELAY_S=30`, and the UI polls fast only while jobs are active.
- Attachments travel inside the job payload (base64). Upstash caps a request at about 1 MB, hence `ATTACHMENT_MAX_KB=512`.

## Provider limits (free tier, enforced by the app)
- **Resend:** 100/day, 2 req/s. Without a verified domain you can only send from `onboarding@resend.dev` to your own account email.
- **EmailJS:** 200/month, 1 req/s. Enable *Allow EmailJS API for non-browser applications* in Account > Security. Attachments need a paid plan.
- Quota counters are kept by this app (Redis), not read from the providers, so they reset to what the app has seen.

## Production checklist
- Set `ACCESS_TOKEN` (the API returns 503 in production without it), and ideally `ALLOWED_RECIPIENTS`.
- Set `ENABLE_SIMULATOR=false`, a unique `QUEUE_PREFIX`, and keep the Redis eviction policy at `noeviction`.
- Use **Diagnostics** (stethoscope icon) to check Redis, workers and credentials. It sends no email.

## Layout
`server/` Hono API, providers, BullMQ queue, balancer, store. `public/` HTML + `js/` modules + vendored Tailwind/Lucide. `tests/` `npm test`.
