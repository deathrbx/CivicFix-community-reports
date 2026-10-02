# CivicFix

CivicFix helps residents document local issues, follow community reports, and find practical ways to improve their neighborhoods.

## Run the app

The project is a static HTML/CSS/vanilla JavaScript frontend served by Vite. Start its existing Replit workflow to preview it. Supabase is the application backend; this app does not use a local database or fake sample reports.

## Connect Supabase

1. Create a project at [supabase.com](https://supabase.com/).
2. In the project, open **SQL Editor**, create a new query, paste all of `supabase/schema.sql`, and run it. This creates the `reports` table, validation rules, indexes, automatic `updated_at` trigger, and ownership-enforcing row security policies.
3. In Supabase, open **Project Settings → API** (or **Data API**) and copy the Project URL and the public `anon` / publishable key.
4. Open `supabase-config.js`. Replace `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` with those two public values. The anon key is intended for browser use; never put the `service_role` key here.
5. In Supabase, open **Authentication → Providers → Email** and enable email/password sign-in. For a competition-only test project, you may temporarily disable email confirmation so a new test account can sign in immediately. Do not disable it for a public launch.
6. Reload the CivicFix preview and create a test account. Authenticated users can read community reports; PostgreSQL RLS enforces that each user can only edit or delete their own.

The dashboard counts are queried from the `reports` table. With an empty database, every count is `0` and the feed shows an honest empty state. No demo rows are inserted.

## Enable CivicAI (optional)

CivicAI is a Supabase Edge Function. Without its provider secret it returns a clear configuration message; report browsing and CRUD continue to work.

Run these commands in a terminal, from the `artifacts/civicfix` directory:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

Get the project reference from the Supabase project URL (the subdomain before `.supabase.co`). Store your provider key in Supabase's secret store, not in the app. With the Supabase CLI installed through `npx`, use a hidden terminal prompt:

```sh
read -s -p "OpenAI API key: " OPENAI_API_KEY
printf "\n"
npx supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"
unset OPENAI_API_KEY
npx supabase functions deploy civic-ai
```

The function verifies the user's Supabase session, limits message/history size, handles errors, and only returns generated content. It does not read private reports or claim to perform civic actions.

## Privacy and security

- Passwords are managed by Supabase Auth and are never stored by CivicFix.
- The browser uses only Supabase's public URL and anon/publishable key.
- Report ownership is enforced by PostgreSQL policies using `auth.uid()`, not by client-side checks alone.
- User-generated report text is rendered as text, not trusted HTML.
- CivicAI conversation history stays in the current page session and is not saved to the database.

## Competition demo

Create a test account, submit a report, show the success moment and updated real counts, open **My Reports**, refresh to demonstrate Supabase persistence, then ask CivicAI “How can our neighborhood reduce litter?” after its function is configured.