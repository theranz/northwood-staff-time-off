# Northwood Staff Time Off

A simple page where Northwood Baptist Church staff request vacation, medical and other time off, see who's out, and check their balances. Pastors approve requests and keep the staff list. Leave rules follow the Employee Handbook (§07.B and §08.A).

## How it's built

- **Cloudflare Worker** (`src/index.js`) serves the page and a small API.
- **Cloudflare D1** database `northwood-staff-time-off` stores the staff list and requests.
- **Cloudflare Access** handles sign-in. Only `@northwoodbaptist.com` emails can open the site, and each person sees their own name automatically.
- The page itself is `public/index.html`.

## Who can do what

| | Staff | Pastors (`ADMIN_EMAILS` in `wrangler.jsonc`) |
|---|---|---|
| Request time off | Their own | Anyone's |
| See who's out | Dates only, not the reason | Everything |
| Balances | Their own | Everyone's |
| Approve / decline | — | Yes |
| Edit staff list | — | Yes |

## Deploying

Cloudflare builds and deploys automatically from the `main` branch of this repository.

To add or remove approvers, edit `ADMIN_EMAILS` in `wrangler.jsonc` and commit.
