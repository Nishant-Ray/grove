# Grove

Vite + React + TypeScript landing page. Inter/Lora fonts are bundled locally; the hero is a custom animated SVG.

## Local development

```sh
npm install
npm run dev
```

`npm run build` type-checks and creates `dist/`. `npm run preview` serves the production build.

## Supabase

See [supabase/SETUP.md](supabase/SETUP.md) for the remaining deployment steps. The original `schema.sql` creates private storage and the submissions table; `integration.sql` adds retry protection and quotas. The Edge Function lives in `supabase/functions/submit-pilot/`.

Live submissions are enabled in local `.env.local` after successful deployed backend verification. The forms show confirmation only after Supabase saves the request and upload. Set `VITE_PILOT_LIVE=true` along with the public URL/key in any future hosting build environment. An unset/false flag safely disables collection with an error rather than pretending to submit. Never put server credentials in a `VITE_` variable.

After activation: form answers and optional files go through the Edge Function to private Supabase storage. Staff inspect submissions in the dashboard. Payment verification, job execution and results email remain manual. Hosting signup does not install software or grant device access.

## Checks

```sh
npm run build
node scripts/test-submissions.mjs
npm run supabase:check
```

The last command checks public table access and endpoint availability without fetching personal records. See SETUP for Edge Function type-checking and live end-to-end verification.

## Pilot scope

The two stepped forms adapt the provided Google Forms: direct job requests and device-host registration. Job requests include file-or-link input (20 MB file limit), frameworks, deadline/timezone and payment matching information. Device specs are required for hosts. Payment is $1 via Venmo @nishantray or Zelle 4082036222; results are emailed only after manual payment verification.

The page supports mobile layouts, native modal focus handling, keyboard navigation, animation pause and reduced motion. Sustainability messaging concerns hardware reuse, without claims of verified clean power or measured energy savings.
