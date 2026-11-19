# Northwood Staff Time Off

A simple page where Northwood Baptist Church staff request vacation, medical and other time off, see who's out, and check their balances. Pastors approve requests and keep the staff list. Leave rules follow the Employee Handbook (§07.B and §08.A).

## How it's built

- **Cloudflare Worker** (`src/index.js`) serves the page and a small API.
- **Cloudflare D1** database `northwood-staff-time-off` stores the staff list and requests.
- **Sign-in** is built in: each person uses their church email and their own password. Pastors set a starting password in the Staff tab; the person picks their own the first time they sign in. Five wrong tries locks an account for 15 minutes.
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

## How days are counted

Days are counted automatically from each person's work week, in whole days. Nobody can change the count, and there are no half days.

- **Class 1–3 (pastoral, full- and part-time):** Sunday–Thursday. A vacation week is 5 days. Fridays and Saturdays never count.
- **Class 4 (full-time support):** Monday–Thursday. A vacation week is 4 days. Fridays, Saturdays and Sundays never count.

## Holidays

The Holidays tab lists the ten paid holidays from Handbook §08.B (Class 1, 2 and 4), with this year's dates worked out automatically.
