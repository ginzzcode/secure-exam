# ARCHITECTURE.md

Secure Exam Portal, system architecture.

Status: draft specification. No application code exists yet.

Companion documents: `PROJECT_SPEC.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `RELIABILITY_AND_SCALE.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Architectural summary

The portal is a static single-page application served from a CDN. It talks to Supabase for authentication, data, and trusted server functions. A trusted server function, called `session-join`, is the only component allowed to decide whether a student may open the exam and to hand back the Google Forms link.

Three trust zones exist:

1. Untrusted client. The browser and everything in it. It holds an anonymous key and a user access token. It can be inspected, modified, and replayed.
2. Trusted server. Supabase Postgres with Row Level Security, and Supabase Edge Functions holding the service-role key and server secrets. Secrets never leave this zone.
3. External. Google Forms, which the portal does not control and cannot make offline.

The core rule: the client never decides eligibility and never holds the Google Forms URL until a trusted function returns it after checks. The student flow is ordered and server-validated: `session-join` validates eligibility and records the participant without returning the URL, `session-acknowledge` records the acknowledgement and returns the URL, and `session-recover` re-issues a previously released URL subject to the session or grace policy. `session-control` is the single canonical name for session control.

Student sign-in uses NISN plus a school-issued password, resolved to the account's native Supabase Auth identifier by a trusted server function (`auth-login`). NISN is an identifier, not a secret. Authentication (sign-in) and authorization (what a session may do) are separate; see section 2.5.

---

## 2. System components

```
+------------------------------------------------------------------+
| Student / Invigilator / Admin browser (React + Vite + JSX, PWA)  |
|  - Supabase JS client with anon key only                         |
|  - Holds a user access token after sign-in                       |
+-----------------------------+------------------------------------+
                              | HTTPS
                              v
+------------------------------------------------------------------+
| CDN / static host                                                |
|  - Serves built SPA assets and the PWA shell                     |
|  - No secrets, no server logic                                   |
+-----------------------------+------------------------------------+
                              | HTTPS (API calls)
                              v
+------------------------------------------------------------------+
| Supabase project                                                 |
|                                                                  |
|  Auth (GoTrue)                                                   |
|   - Email/password sign-in, invites, resets                      |
|                                                                  |
|  Postgres + PostgREST                                            |
|   - All tables, RLS enabled                                      |
|   - Client queries filtered by RLS                               |
|                                                                  |
|  Edge Functions (Deno)                                           |
|   - auth-login        (NISN -> native id, verify, issue session) |
|   - session-join      (eligibility, records participant)         |
|   - session-acknowledge (record ack, release link)              |
|   - session-recover   (re-issue link within grace policy)        |
|   - admin-provision   (create accounts, assign roles)            |
|   - session-control   (revoke, close, remove, extend)            |
|   - These hold the service-role key and the code pepper          |
|                                                                  |
|  Realtime (optional)                                             |
|   - Live participant updates for invigilators                    |
+-----------------------------+------------------------------------+
                              | Browser redirect or direct open
                              v
+------------------------------------------------------------------+
| Google Forms (external)                                          |
|  - Questions and responses                                       |
|  - Online only                                                   |
+------------------------------------------------------------------+
```

### 2.1 Frontend (React + Vite + JSX)

- Single-page app, no server-side rendering.
- Routing with a client router. Role-aware route guards, treated as convenience only because real authorization is server-side.
- Supabase JS client configured with the project URL and the anonymous key. The service-role key is never included in any build.
- A small API module centralizes calls to Edge Functions and the database client.
- PWA manifest and service worker cache the static shell. The service worker does not cache authenticated data or form links.
- State: a lightweight store for session, active membership, and role; data fetching with a single query library (for example TanStack Query) for caching, retries, and error states.

### 2.2 Supabase Auth

- Staff sign in with administrator-provisioned credentials (for example email and password).
- Students sign in with NISN and a school-issued password. The browser does not call Supabase Auth directly for student sign-in. It calls the `auth-login` function, which resolves NISN to the account's native Supabase Auth identifier and performs the password sign-in server-side. See section 2.5.
- Public sign-up disabled. All accounts are created by an administrator.
- The Auth user id (`auth.uid()`) is the join key to the `profiles` and `memberships` tables used by RLS.
- Passwords are stored and verified only by Supabase Auth. The portal never stores a plaintext password.
- Password resets and recovery are administrator-initiated. The exact flow is an open decision (see section 12 and `ACCESS_CONTROL.md`).

### 2.3 Postgres with Row Level Security

- All tenant data carries `school_id`.
- RLS enabled on every table reachable by the anon or authenticated role.
- Policies derive the caller's role and school from `memberships` and `profiles`.
- The Google Forms URL is stored so that no student policy can return it. See section 5.

### 2.4 Edge Functions

Trusted, server-side operations. They run with the service-role key and are the only place secrets live.

| Function | Responsibility | Called by |
| --- | --- | --- |
| `auth-login` | Resolve NISN to the native Auth identifier, rate limit, verify the password through Supabase Auth, return a session. | Student |
| `session-join` | Validate a session code and full eligibility, rate limit, create or update the participant as `joined`, write audit. Does not return the form link. | Student |
| `session-acknowledge` | Record the student's acknowledgement once, release the link, write audit, and return the form link. Idempotent. | Student |
| `session-recover` | Re-issue a previously released form link after revalidating identity, active profile and membership, school, assignment, participant status, and the session or grace policy. Idempotent. | Student |
| `admin-provision` | Create Auth users, set initial passwords, set profiles, create memberships, create NISN login aliases. | Administrator |
| `session-control` | Revoke a code, close a session, remove a participant, extend a window if policy allows. The canonical name for session control; no other name is used. | Invigilator, administrator |
| `report-export` | Produce a signed CSV export of a session report. | Administrator, assigned invigilator |
| `form-redirect` (deferred) | Not part of the MVP. The form link is returned directly by `session-acknowledge` or `session-recover`. | none |

Each function verifies the caller's JWT, resolves the membership and role, and applies authorization checks in addition to RLS. Functions are idempotent where a client may retry.

### 2.5 NISN-based login architecture (proposed)

Constraint: Supabase Auth natively signs a user in with an email or a phone identifier plus a password (or with OTP or OAuth). It does not support an arbitrary username such as NISN as a direct identifier. NISN is a national student number, not an email or a phone, and it is an identifier, not a secret. Therefore NISN is not passed to Supabase Auth as a native identifier. It is used as a server-side login alias.

Proposed flow:

1. Provisioning (administrator, `admin-provision`):
   - Create the Supabase Auth user with a real native identifier (see the unresolved decision below).
   - Set the school-issued initial password.
   - Insert a `login_identifiers` row mapping `(school_id, nisn)` to the Auth user id.
2. Sign-in (student, `auth-login`):
   - The browser posts `{ nisn, password }` to `auth-login`. It never calls Supabase Auth directly for student sign-in.
   - The function rate limits by HMAC(NISN) and source, resolves NISN to the Auth user id and native identifier (service role), checks the profile and membership status, and calls Supabase Auth `signInWithPassword` with the resolved native identifier and the supplied password.
   - On success, the function returns the session tokens; the client then handles the session as usual.
   - On failure, it returns a generic error, counts the attempt, and audits it.
   - The native identifier is never shown to, or required from, the student.
3. Authorization is unchanged and separate: after the session is issued, RLS and Edge Functions validate membership, role, assignment, and session policy (see `ACCESS_CONTROL.md`). A valid session grants no data access on its own.

Native identifier, the key unresolved decision:

- Preferred: a school-issued email address the school actually controls.
- Alternative: a phone identifier, which adds SMS provider cost and coverage risk.
- Rejected: fabricating a fake or synthetic email address (forbidden by the requirements).
- This decision blocks student provisioning in M3. See `PROJECT_SPEC.md` section 12 and `IMPLEMENTATION_PLAN.md`.

Alternatives considered and rejected:

- The client calls `signInWithPassword` with NISN in the email field: NISN is not a valid email identifier.
- Store NISN in user metadata and treat it as a username: metadata is not an authentication factor, it exposes the mapping, and it cannot by itself issue a session.
- Synthetic email per NISN: rejected (fabricated addresses are not permitted).
- Custom JWT signing or an external token issuer: technically possible but more complex and version-sensitive. Keep as a fallback and verify against current Supabase documentation at implementation time.

Password lifecycle:

- Generated by the school at provisioning: unique and random per student.
- Verified by Supabase Auth. The portal never stores a plaintext password.
- Historical context: the previous format was six random letters (for example `SZBFAB`). This is context only and is not a requirement for this project.
- Distribution: out-of-band, per student. Method unresolved.
- Recovery: administrator-initiated. Method unresolved.
- Forced change at first sign-in: unresolved.

Implementation dependency: confirm current Supabase Auth capabilities (administrator user creation with a chosen identifier, server-side password sign-in, and session refresh) against the provider documentation during M3.

---

## 3. Data flows

### 3.1 Sign-in

Staff sign-in (direct to Supabase Auth):

```
Browser -> Supabase Auth: email + password
Auth -> Browser: access token (JWT), refresh token
Browser -> Postgres (PostgREST): read profiles, memberships with token
Postgres RLS: only rows for this user's school and role are returned
Browser: selects active role context
```

Student sign-in (NISN through a trusted function):

```
Browser -> auth-login: { nisn, password }
auth-login:
  1. Rate limit by HMAC(nisn) and source
  2. Resolve nisn -> user_id + native identifier (service role, login_identifiers)
  3. Check profile and membership status (deny if disabled or suspended)
  4. Call Supabase Auth signInWithPassword(native_identifier, password) server-side
  5. On success: return session tokens + minimal profile
  6. On failure: generic error, count attempt, audit
Browser -> Postgres (PostgREST): read profiles, memberships with the session token
Postgres RLS: only rows for this user's school and role are returned
```

The native identifier and the plaintext password are never logged and never returned to the browser.

### 3.2 Administrator prepares an exam

```
Admin browser -> admin-provision: create student accounts      -> Auth + profiles + memberships
Admin browser -> Postgres: insert exam (draft)                  (form URL written to protected store)
Admin browser -> Postgres: insert assignments, sessions
Admin browser -> session-control: generate code (or scheduled job)  -> hashed code stored
Admin publishes exam: status = published
```

The Google Forms URL is written once to the protected store (section 5) and is never returned by a normal Postgres read path used by students.

### 3.3 Student joins, acknowledges, and receives the link (the critical path)

The flow is three ordered, server-validated operations. The client cannot skip a step, and no operation returns the form URL before its prerequisites hold.

Step 1, join (no link returned):

```
Student browser -> session-join: { session_code, session_id?, idempotency_key }
session-join:
  1. Verify JWT and resolve membership (role=student, school)
  2. Load session, exam, assignment, participant if any
  3. Server time check: is the join window open? session not closed/cancelled?
  4. Compare code: HMAC(code + pepper) against stored code_hash
  5. Confirm student is assigned (direct or via class)
  6. Confirm exam is published and participant not removed
  7. Rate-limit checks (student, session, source address)
  8. Upsert participant: invited -> joined (idempotent on (session_id, student_id))
  9. Write audit row (decision, result, reasons)
 10. Return { participant_status } only. The form URL is NOT returned.
```

Step 2, acknowledge and first release:

```
Student browser -> session-acknowledge: { session_id, idempotency_key }
session-acknowledge:
  1. Verify JWT and resolve membership (role=student, school)
  2. Confirm the participant exists and is joined or acknowledged
  3. Confirm the session is still open (no first release after close or expiry)
  4. Record the acknowledgement once (set acknowledged_at if null), write audit
  5. Record the release once (set released_at if null; increment release_count
     only for a genuine release, not for a retry)
  6. Read the form URL from the protected store
  7. Return { form_url, participant_status }
```

Step 3, recovery of a previously released link:

```
Student browser -> session-recover: { session_id, idempotency_key }
session-recover:
  1. Verify JWT and resolve membership (role=student, school)
  2. Confirm the participant is released and not removed
  3. Confirm the applicable policy: session open, or session ended and now is
     strictly before the configured grace-period boundary
  4. Rate-limit checks
  5. Read the form URL from the protected store
  6. Write audit and a logical release event (idempotent per request)
  7. Return { form_url, participant_status } or deny if the boundary has passed
```

No operation returns the form URL from a cache. Every return of the URL revalidates the session and grace policy on the server. A retried join, acknowledgement, or recovery does not duplicate the participant, the acknowledgement, or a logical release event.

The Google Forms link is returned directly in the response. The optional logging redirect is deferred (section 5.3).

### 3.4 Invigilator runs a session

```
Invigilator browser -> Postgres: read own session + participants (RLS)
Invigilator browser -> session-control: revoke code / close / remove / extend
session-control: verify role and assignment, apply change, write audit
Optional: Supabase Realtime pushes participant changes to the invigilator view
```

### 3.5 Report and export

```
Admin/Invigilator browser -> report-export: { session_id }
report-export: verify role and access, assemble rows, sign a short-lived download URL
Browser -> download CSV
report-export: write audit row for the export
```

---

## 4. Deployment model

- Frontend: build with Vite, deploy static output to a CDN host. Candidate hosts: Vercel, Netlify, Cloudflare Pages, or Supabase Storage with a CDN. The choice is an open question because it affects free-tier limits and analytics.
- Backend: one Supabase project per environment (development, staging, production). The production project holds one school in the MVP but the schema supports many.
- Region: choose the Supabase region closest to the school to reduce latency. Confirm with the school's location before provisioning.
- Secrets: stored in Supabase Edge Function secrets. Never in the repository, never in the frontend build.
- Environments: separate Supabase projects for staging and production, separate anon keys, separate service keys.
- Migrations: versioned SQL migrations applied through the Supabase CLI. No manual schema edits in production.
- Domain: a school-controlled domain or subdomain for the portal, so the QR code stays stable if the host changes. Use a redirect or a stable custom domain.

### 4.1 What runs where

| Concern | Runs on |
| --- | --- |
| Rendering, routing, forms, error states | Browser |
| Authentication (identity and password verification) | Supabase Auth |
| Student NISN sign-in resolution and rate limiting | `auth-login` Edge Function |
| Data reads and simple writes | Postgres through PostgREST, gated by RLS |
| Eligibility and code check (no link returned) | `session-join` Edge Function |
| Acknowledgement and first link release | `session-acknowledge` Edge Function |
| Post-session link recovery | `session-recover` Edge Function |
| Account provisioning and NISN aliases | `admin-provision` Edge Function |
| Session control and audit-sensitive writes | `session-control` Edge Function |
| Report export | `report-export` Edge Function |
| Questions and answers | Google Forms (external) |

---

## 5. Protecting the Google Forms URL

This is the central security design decision. Hiding a URL in the client interface is not protection. The requirements say not to assume that hiding a URL in the UI protects it, and this design follows that.

Approach:

1. The URL is stored in a table, for example `exam_form_links`, that has no student-select policy and no policy for the anon or authenticated role at all. RLS denies all reads to clients. Only the service role reads it.
2. A student never queries that table. `session-acknowledge` reads it with the service role and returns the URL only after eligibility and acknowledgement succeed; `session-recover` reads it only within the applicable session or grace policy.
3. The Google Forms link is returned directly in the response. The optional logging redirect (`form-redirect`) is deferred and is not part of the MVP.

Honest limitations, restated here and in `THREAT_MODEL.md` and `RELIABILITY_AND_SCALE.md`:

- Once the URL reaches the browser it can be copied, shared, or opened on another device. The portal cannot retract it.
- A determined student can share the URL within the join window. Mitigations that reduce but do not eliminate this: short windows, per-student audit, invigilator presence, optional Google Forms access restriction to the school account domain.
- Because the link is returned directly and the redirect proxy is deferred, there is no portal-controlled revocable link; the underlying form URL remains reachable if copied.

---

## 6. Server-authoritative timing and validation

- The server, not the client, decides whether a session is open. The client displays server values and refreshes them.
- The server clock is the single source of truth. Client clocks are assumed wrong.
- All eligibility checks run in `session-join` on the server. The client's role guard is cosmetic and never the last line of defense.
- Session code comparison uses a server secret (pepper) so the database alone cannot validate or reveal codes.
- The link-recovery grace boundary is computed on the server from the session end plus the configured duration. The client never decides whether recovery is allowed.

---

## 7. Caching strategy

- Static assets: cached aggressively by the CDN and the service worker (hashed filenames).
- PWA shell: cached so a repeat load works while the network is down enough to show the shell and a connection-error state.
- Authenticated data: not cached in the service worker. In-memory query caching with short stale times is acceptable in the client only.
- Form links: never cached by the service worker. Held in memory for the session.
- The interface must never present cached exam data as current when the network is gone. Show the last known state with a clear stale marker and a retry action.

---

## 8. Multi-tenant design

- Every tenant-owned row has `school_id uuid not null references schools(id)`.
- RLS policies filter by the caller's school obtained from `memberships`.
- A "current school" concept is carried in the active membership. In the MVP a user has one active school, but the schema and policies do not assume exactly one.
- Indexes lead with `school_id` where queries are tenant-scoped.
- Cross-tenant reads return zero rows and are treated as a test failure if they ever return data.

Details are in `DATABASE_DESIGN.md` and `ACCESS_CONTROL.md`.

---

## 9. Architectural decisions (ADR style)

| ID | Decision | Rationale | Alternative rejected |
| --- | --- | --- | --- |
| AD-01 | Server-authoritative eligibility in an Edge Function | The client is untrusted; timing and code checks must be server-side. | Client-side checks (rejected, bypassable). |
| AD-02 | Form URL in a table with no client policy | RLS is row-level, so a URL a student must not read belongs in a table students cannot read at all. | Storing the URL on the exam row and hiding it in the UI (rejected, leaks via API). |
| AD-03 | Session codes stored hashed with a pepper | A database dump must not reveal active codes. | Plaintext codes (rejected). |
| AD-04 | Idempotent join keyed on (session_id, student_id) | Mobile retries are common; duplicates are worse than rejected retries. | Non-idempotent insert (rejected). |
| AD-05 | Static per-room QR to the portal only | Meets the requirement and keeps the code out of the QR. | QR to exam or form URL (rejected by requirement). |
| AD-06 | PWA shell only, no offline data promises | Google Forms is online only; caching exam data misleads users. | Full offline PWA (rejected as dishonest). |
| AD-07 | Activity signals recorded, never scored as cheating | Signals like tab visibility are unreliable and can be triggered by notifications. | Automatic cheating score (rejected as unfair and unsupported). |
| AD-08 | Single Supabase project, schema ready for many schools | Low cost for one school, no redesign for a second. | Per-school projects (more cost and ops now). |
| AD-09 | Audit log append-only via RLS | Records must survive and be trustworthy. | Editable logs (rejected). |
| AD-10 | Frontend host chosen by free-tier fit, decided later | Affects cost and analytics; needs a decision. | Committing now without testing limits. |
| AD-11 | NISN is a server-side login alias, not a native Supabase identifier | Supabase Auth has no arbitrary-username flow; NISN maps to the account's native identifier in a service-role table. | Passing NISN as an email (invalid), or as metadata (not an auth factor). |
| AD-12 | Fabricated email addresses are rejected | The requirements forbid inventing fake emails; the school must supply a real, controlled identifier. | Synthetic `nisn@...` addresses (rejected). |
| AD-13 | Supabase Auth remains the password authority | Passwords stay hashed and verified by the provider; the portal never stores or checks plaintext. | A separate credential store in the portal (rejected as duplicate risk). |
| AD-14 | Post-session link recovery is gated by a school-configured grace period | The school must set the duration; no default is assumed. | Hard cutoff at session close (rejected by the confirmed decision). |
| AD-15 | Acknowledgement is a separate server-validated operation from join | The link must not be returned by the join step; a distinct operation records consent and then releases the link. | Returning the link from join (rejected: entangles eligibility with consent and breaks the review checklist). |
| AD-16 | Link recovery is a separate server-validated operation gated by the session and grace policy | Re-opening a released link must revalidate identity and policy, including the grace boundary. | Serving a cached URL on a generic retry (rejected: bypasses grace policy). |
| AD-17 | `session-control` is the single canonical name for the session-control function | One name avoids drift between documents, diagrams, and code. | `close-session` or `session-control` used as aliases (rejected; one name only). |

---

## 10. Technology choices and versions

- React with Vite and JSX. No TypeScript requirement stated, so JSX is used. If the school prefers typed code, this is an open question.
- Supabase JS client for Auth, PostgREST, Realtime, and Edge Function calls.
- Edge Functions in Deno.
- Postgres 15 or newer as provided by Supabase.
- A client data-fetching library such as TanStack Query for retries and error states (a decision to confirm, flagged as open).

---

## 11. Failure modes and boundaries

| Failure | Expected behavior |
| --- | --- |
| Supabase Auth unavailable | Sign-in shows an error and a retry. Existing valid tokens keep working until expiry. |
| `session-join` unavailable | Join fails closed. No form URL is returned from any cache. Show a connection-error state. |
| Postgres slow | Queries time out with a retry action. Writes that may have applied are retried idempotently. |
| Google Forms unavailable | The portal can still hand out the link; the student sees Google's own error. The portal states it does not control Google Forms. |
| Network drops mid-join | The browser cannot know if the server applied the join. The retry uses the idempotency key so the result is the same. |
| `auth-login` unavailable | Student sign-in fails closed. No session is issued. Show a sign-in error and a retry. |
| NISN has no alias row | Sign-in fails with a generic error. The attempt is audited; an administrator resolves aliases. |
| Account disabled or suspended | Sign-in is denied with a generic error even if a password is correct. |
| `session-acknowledge` unavailable | No link is returned. The join remains recorded as joined; the student retries the acknowledgement. |
| Recovery requested after the grace boundary | Denied. The link is not returned. The attempt is audited. |
| Recovery requested for a removed participant | Denied, regardless of timing. |

---

## 12. Open questions

1. Frontend host selection and its free-tier limits (also in `RELIABILITY_AND_SCALE.md`). Blocks M1.
2. Whether Supabase Realtime is used for the invigilator console or polling is sufficient.
3. Client data-fetching library choice.
4. Whether JSX-only is acceptable or the school expects typed code.
5. Where the PWA is served from and whether the service worker is allowed on the chosen host.
6. The native Supabase Auth identifier for student accounts (school-issued email, phone, or another approved scheme). Blocks M3.
7. Password length and character set, and whether a forced change at first sign-in is required. Blocks M3.
8. How initial passwords are distributed and how account and password recovery is handled and verified. Blocks M3.
9. The exact duration of the post-session link-recovery grace period (a confirmed feature; no default). Blocks M5.
10. Who is authorized to configure the grace-period duration. Blocks M5.
11. Whether a manual session close changes the grace-period calculation. Blocks M5.
12. Whether recovery is also exposed while a session is still open, or only after it ends. Blocks M5.

Note: the optional `form-redirect` logging proxy is deferred and is not part of the MVP. The form link is returned directly after acknowledgement.
