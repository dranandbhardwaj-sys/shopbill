# ShopBill – GST billing for Indian shops

Single-page app (`index.html`) + zero-dependency Node backend (`server.js`, Node 18+).

## Run locally

```bash
npm start
```

Open http://localhost:3000

## Environment variables (all optional)

| Variable | Default | Use |
|----------|---------|-----|
| `PORT` | 3000 | Server port |
| `SECRET` | auto-generated | Token signing secret |
| `DATA_DIR` | `./data` | Where `db.json` is stored |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Store data in Upstash Redis (needed on Render free plan, where disk is wiped) |
| `SIGNUP_COINS` / `BILL_COINS` / `REMINDER_COST` | 10 / 1 / 1 | Coin settings |

## Important

- Set `SECRET` on your host so logins survive restarts.
- On Render free plan use Upstash Redis, otherwise user data is lost on redeploy.
- `data/` is git-ignored; never commit real user data.
- Bills involve GST: have a CA verify tax calculations before real customers use it.
