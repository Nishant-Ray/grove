# Deploy Grove on Vercel and Supabase

Use two Vercel projects connected to the same GitHub repository. The browser uses the web project's domain for both pages and /api requests. Keep the API destination and authentication return URL distinct.

## 1. Prepare Supabase

1. Open the intended production project. In **SQL Editor → New query**, run [the host devices migration](backend/supabase/migrations/20261119000100_host_devices.sql), then run [the dashboard migration](backend/supabase/migrations/20261119000200_job_dashboard.sql) in a second query. Skip a migration already applied to that project. These files create tables, grants, owner access policies and a private results bucket.
2. In **Table Editor**, confirm `host_devices` and `compute_jobs` exist with row-level security enabled. In **Storage**, confirm `grove-job-results` is private.
3. In **Authentication → Sign In / Providers**, enable new user signups and the Email provider. For verified emails, enable Confirm email. Configure custom SMTP in Auth's email settings for delivery to people outside your Supabase team. Keep the signup template's `{{ .ConfirmationURL }}` link.
4. In **Authentication → URL Configuration**, set **Site URL** to the public frontend origin, e.g. `https://grove-kappa-six.vercel.app`. Add that exact origin plus `/api/auth/confirm` under **Redirect URLs**. Save.
5. Copy the project's URL and **publishable key** from the project's Connect dialog or API settings. Grove uses user sessions and row policies for data access.

## 2. Create the API project

1. In Vercel choose **Add New → Project**, import the same Grove GitHub repository again, and name the new project `grove-api` (or another available name).
2. Set **Root Directory** to `backend`, select the FastAPI framework preset, and keep the default build/install/output settings. Vercel loads the ASGI app from `index.py`. The default branch may still contain only the older scaffold until the stack merges.
3. Under **Environment Variables**, set the following for Production. If testing previews, add Preview values too, using a test Supabase project and the stable preview **frontend** origin for those values.

| Variable | Production value |
| --- | --- |
| SUPABASE_URL | Production Supabase project URL |
| SUPABASE_PUBLISHABLE_KEY | Production Supabase publishable key |
| GROVE_WEB_URL | Public HTTPS frontend origin |
| GROVE_COOKIE_SECURE | true |

4. Deploy. In **Settings → Domains**, copy the API project's stable HTTPS domain. Use the production domain for the frontend's production destination. For a full preview before merging, deploy the deployment-settings branch on both projects and use the API branch alias as the frontend's Preview destination. The API destination must accept server-to-server requests from the rewrite; a Vercel protection login page in place of JSON indicates Deployment Protection blocked it. Use a reachable API domain with Grove authentication enforced. For email tests on a preview, allow the exact frontend preview callback in the test Supabase project.

## 3. Configure the existing web project

1. Open the original Grove Vercel project. Under **Settings → Build and Deployment**, select **Vite**, root `apps/web`, build command `npm run build`, and output directory `dist`.
2. Under **Settings → Environment Variables**, create **GROVE_API_ORIGIN** for Production. Paste the API project's stable HTTPS origin with no path. Add the corresponding Preview value if using previews.
3. Save. The checked-in web configuration forwards `/api/*` to that origin, preserving the path. The browser uses same-origin cookies. Redeploy after changing environment variables.

## 4. Merge and verify

1. Merge accounts/profiles into main, then dashboard into main, then deployment settings into main. Keep base branches until dependent PRs are retargeted. For each PR, verify the base and Files changed before merging.
2. In both Vercel projects confirm the production branch is main and deploy the final merged commit. In Deployments, verify both production deployments are Ready and assigned their production domains.
3. On the API domain open `/health` and expect `{"status":"ok"}`. In a signed-out browser open `/api/profile` on the **web domain** and expect HTTP 401 with `Please log in.`. A 503 about account services points to missing backend configuration. HTML or a Vercel error points to routing or deployment protection.
4. From the web domain register a user, follow the confirmation email if enabled, sign in, edit the profile, add a device, reload and log out. Sign back in and open the dashboard. Empty job views are expected until the job submission service creates records.

The account site requires no pilot deployment, pilot flags or deletion of historical pilot data.

[FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi) · [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-ts) · [Supabase Auth redirects](https://supabase.com/docs/guides/auth/redirect-urls) · [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
