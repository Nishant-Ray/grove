# Finish the Grove integration

Current state: the Edge Function is deployed and verified; live collection is enabled locally with the user's confirmation. The steps below document setup for a new deployment.

1. In the project's SQL Editor, run `integration.sql` (after the original `schema.sql`). This adds retry protection and an atomic reservation function. Do not grant public access to the table or bucket.
2. From the project directory run `npx supabase login`. Complete the login yourself; never paste a personal access token into chat or a Vite variable.
3. Run `npm run supabase:deploy`. The script derives the project ref from `.env.local`; no database password or Docker is needed because deployment uses the API bundler.
4. Run `npm run supabase:check`. Expect public table reads to be denied and the function preflight to return 204.
5. Before activating a new deployment, verify synthetic host/job requests and a small test upload, private records/files, rejected invalid inputs and anonymous reads. This was completed for the current project.
6. Set `VITE_PILOT_LIVE=true` in the local or hosting build environment, and restart Vite or rebuild the site. The UI now explains storage and shows real submission confirmations. The unset/false flag disables submission with an error.

## Production origin

The function initially allows only `http://localhost:5173` and `http://127.0.0.1:5173`. Before using another Vite port or deploying the site, add its exact origin to the `ALLOWED_ORIGINS` Edge Function secret in Supabase. Use comma-separated origins with no trailing slash. CORS is browser access control, not authentication or bot protection.

## Data flow

Browser -> `submit-pilot` Edge Function -> private `pilot_submissions` table and `pilot-workloads` bucket. No visitor accounts or additional external services.

The endpoint streams a bounded request, validates fields and actual file bytes, reserves a row, uploads an inert file, and marks it `pending_review` only after saving finishes. It uses Supabase's built-in server-side `SUPABASE_SERVICE_ROLE_KEY`, never a browser secret. Neither job execution nor payment verification nor results email is automated.

Retries with an unchanged request ID/payload resume safely. If you edit a request after a network failure and get a conflict, close the form and start a new one. Incomplete rows stay `receiving`; they may have an uploaded file. Inspect and remove abandoned rows and matching Storage objects through the dashboard periodically. Do not process `receiving` rows.

Basic quotas are 5 requests per email/hour and 50 total/day. These are pilot abuse limits, not robust bot detection; email addresses are not verified. Monitor total storage and prune files after returning results. The 20 MB/file limit does not cap cumulative storage. Add stronger abuse protection before promoting the site widely.

Files have extension/text/JSON/ZIP signature checks, not malware scanning. Review untrusted code in an isolated environment; this endpoint never executes it. Keep uploaded files private.

## Local checks

`npm run build` checks the frontend. `node scripts/test-submissions.mjs` checks backend validation. In PowerShell, run `$env:DENO_NO_PACKAGE_JSON='1'` followed by `npx --yes deno check --config supabase/functions/deno.json supabase/functions/submit-pilot/index.ts` to type-check the isolated Edge Function without resolving unrelated frontend dependencies.

References: https://supabase.com/docs/guides/functions/deploy and https://supabase.com/docs/guides/functions/auth
