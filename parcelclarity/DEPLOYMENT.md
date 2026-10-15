# Deployment

Target: **Vercel** (Next.js) + **Supabase** (PostgreSQL, Auth, later Storage). Nothing here has been run against hosted infrastructure yet; treat the checklist as the verification plan for the first deploy.

## 1. Supabase project

1. Create a project (choose a region near your customers). Note the project URL and the **anon** key (Settings → API). Keep the **service_role** key secret; Milestone 1 does not need it.
2. Apply migrations in order, either with the CLI (`supabase link --project-ref <ref>` then `supabase db push`) or by running each file in `supabase/migrations/` in the SQL editor.
3. Authentication → URL configuration:
   * **Site URL**: your production URL (e.g. `https://app.example.com`)
   * **Redirect URLs**: `https://app.example.com/**` (plus preview URL patterns if wanted)
4. Authentication → Providers → Email: **Confirm email ON**, **Secure password change ON**, minimum password length **10**. Enable CAPTCHA (Turnstile/hCaptcha) and review rate limits under Authentication → Rate Limits; sign-in and recovery are throttled only by these settings.
5. Authentication → SMTP: configure a real SMTP provider. The built-in sender is heavily rate-limited and not for production.
6. Authentication → Email Templates: use the token-hash templates below so links work when the email is opened on another device.

### Email templates (recommended)

The app sends `emailRedirectTo = <site>/auth/confirm?next=<path>`. With Supabase's **default** templates, the link signs the user in via PKCE (`?code=`), which only works in the browser that requested the email. The templates below use the token hash instead, which also works when the email is opened on a different device (common: sign up on a laptop, open the email on a phone). `{{ .RedirectTo }}` already contains `?next=…`, so the token is appended with `&`.

Confirm signup:
```html
<h2>Confirm your email address</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=signup">Confirm email address</a></p>
```
Reset password:
```html
<h2>Reset your password</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Choose a new password</a></p>
```

Both the PKCE and token-hash paths of `/auth/confirm` are covered by automated tests locally; **your hosted templates are not**. On the first deploy, test each template by hand: sign-up confirmation, sign-up *from an invitation link* (it must return to the accept-invitation page), and password reset, ideally opening the email on a different device.

## 2. Vercel project

* Root directory: `parcelclarity`
* Framework preset: Next.js; Node 22
* Environment variables (Production and Preview):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | canonical URL, no trailing slash |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key |
| `RESEND_API_KEY`, `EMAIL_FROM` | for invitation email (optional; without them admins get a link to share) |
| `SUPABASE_SERVICE_ROLE_KEY` | **not needed in Milestone 1**; do not set until a feature requires it |

`NEXT_PUBLIC_*` values are baked in at build time; redeploy after changing them.

## 3. Resend (invitation email)

Verify a sending domain (SPF/DKIM), create an API key, set `RESEND_API_KEY` and `EMAIL_FROM` (`"ParcelClarity <no-reply@yourdomain>"`). Send a test invitation and confirm delivery; this integration has not been tested against the real service.

## 4. First platform administrator

After signing up through the app, run in the SQL editor:

```sql
insert into public.platform_admins (user_id) select id from auth.users where email = 'you@example.com';
```

## 5. Production checklist

**Before first real user**
- [ ] Migrations applied; `select count(*) from pg_policies where schemaname='public'` shows policies for every table; RLS enabled everywhere (`select relname from pg_class where relrowsecurity = false and relnamespace = 'public'::regnamespace and relkind = 'r'` returns nothing)
- [ ] Redirect URLs and Site URL set; email confirmation ON; password min length 10; CAPTCHA + rate limits configured; custom SMTP set
- [ ] Email templates updated; sign-up confirm, invitation sign-up, and password reset each tested on a phone and desktop
- [ ] Invitation email delivered by Resend (not just the copy-link fallback)
- [ ] Run `npm run test:db`'s scenarios you can reproduce on staging (at minimum: two tenants, confirm brand A cannot see brand B, cross-tenant URL returns 404)
- [ ] `NEXT_PUBLIC_SITE_URL` is HTTPS and matches the Supabase Site URL
- [ ] HSTS applies only over HTTPS; confirm security headers with a scanner
- [ ] Platform admin created; confirm they cannot see tenant data in the UI

**Operations (not yet built or verified; do before storing real customer data)**
- [ ] Supabase backups/PITR enabled; **restore drill performed and documented**
- [ ] Error monitoring (e.g. Sentry) added and verified
- [ ] Uptime monitoring and alerting
- [ ] Content-Security-Policy added (Milestone 9)
- [ ] Data retention and tenant export/deletion procedure defined
- [ ] Dependency scanning (`npm run audit`, Dependabot) in CI
- [ ] Real-iPhone Safari pass: sign-in, Add to Home Screen, standalone launch, file upload (once available), PDF share (once available)

## 6. iOS / PWA notes

The app is an installable PWA (manifest, icons, minimal service worker) and is **not** an App Store app. Add to Home Screen on iOS happens from Safari's Share sheet. Native packaging with Capacitor remains possible: the UI uses standard web APIs and server-validated sessions. Not attempted yet.

## 7. Stripe

Not integrated yet (Milestone 7). When added: configure webhook signing secret, run webhook tests in Stripe test mode, and only then enable live keys. **No real charges will be enabled until you confirm.**
