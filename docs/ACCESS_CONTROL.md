# ACCESS_CONTROL.md

Secure Exam Portal, access control and authorization.

Status: draft specification. No application code exists yet.

Companion documents: `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `THREAT_MODEL.md`, `RELIABILITY_AND_SCALE.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Model overview

Access control has three layers, and all three must agree:

1. Row Level Security in Postgres. The database itself filters every row a client can read or write. This is the enforceable boundary for client queries.
2. Edge Function authorization. Trusted operations re-check the caller's role and assignment before doing anything a client query cannot safely do, and before returning the Google Forms URL.
3. Client route guards. Cosmetic only. They improve the experience and never serve as a security boundary.

Identity comes from `auth.uid()` through Supabase Auth. Role and school come from the `memberships` table, resolved by SQL helper functions. A user with no active membership for a school gets nothing from that school.

Authentication (who the user is) is separate from authorization (what the user may do). A student authenticates with NISN and a school-issued password through the `auth-login` function, which yields a Supabase session. That session then has to pass the RLS and Edge Function checks below. A valid session alone grants no data access.

---

## 2. Subjects, roles, and resources

Subjects: an authenticated user (a profile), acting under one active membership in one school.

Roles: `school_admin`, `invigilator`, `student`.

Resources: schools, profiles, memberships, login identifiers, login attempts, classes, enrollments, exams, exam form links, assignments, sessions, session codes, invigilators, participants, link events, activity events, audit events, reports.

---

## 3. Permission matrix

Legend: F = full within their school and scope, R = read, W = write or create, A = action through a trusted function, = none. "Own" means rows tied to the caller.

| Resource / action | school_admin | invigilator | student |
| --- | --- | --- | --- |
| School settings | R, W | | |
| Profiles (accounts) | R, W (provision, disable) | R (names only, for own sessions) | R (own) |
| Memberships | R, W | | R (own) |
| Classes | R, W | R | |
| Class enrollments | R, W | R (own sessions only) | R (own) |
| Exams (definition, status) | R, W | R (assigned sessions only) | R (assigned only, no form URL) |
| Exam form link | A (set through function) | | A (only via `session-acknowledge` and `session-recover` after checks) |
| Exam assignments | R, W | R (assigned sessions only) | R (assigned only) |
| Sessions (schedule) | R, W | R (assigned only) | R (assigned exams only) |
| Session codes | A (generate, revoke, view) | A (view, revoke own sessions) | |
| Session invigilators | R, W | R (own) | |
| Participants | R, W (remove) | R, W (remove, mark) | R (own) |
| Activity events | R | R (own sessions) | W (own, client reported) |
| Audit events | R | R (own sessions) | |
| Reports and CSV export | R | R (own sessions) | R (own participation only, no activity detail) |

Notable denials:

- A student can never read `exam_form_links` or `session_codes`.
- A student can never read another student's participant or activity rows.
- An invigilator can never see a session they are not assigned to.
- No client role can update or delete `audit_events`.
- No client role can read another school's rows of any table.

---

## 4. Authorization predicates

One definition per predicate, used by both RLS and Edge Functions, so there is no drift.

| Predicate | Meaning |
| --- | --- |
| `current_school_id()` | The active school for `auth.uid()`, from an active membership and an active profile. |
| `current_role()` | The role in the active school. |
| `is_school_admin(school uuid)` | Caller has an active `school_admin` membership in `school`. |
| `is_session_invigilator(session uuid)` | Caller has an active `invigilator` membership and a `session_invigilators` row for the session. |
| `is_assigned_student(exam uuid)` | Caller has an active `student` membership and is assigned directly or via an active class enrollment. |
| `session_effective_status(session uuid)` | Server-derived status from time and manual state. |
| `profile_is_active()` | `profiles.status='active'` and membership status is `active`. |

All predicates return false, never error, when the caller is unauthenticated, disabled, or suspended.

---

## 5. RLS strategy

RLS is enabled on every table in `DATABASE_DESIGN.md` that a client role can reach. `exam_form_links` and `session_codes` have RLS enabled with no permissive policy for client roles.

### 5.1 Policy shape

Read policy for tenant rows:

```sql
-- illustrative, not final
create policy classes_select on classes
for select using (
  school_id = current_school_id()
  and (
    is_school_admin(school_id)
    or current_role() in ('invigilator','student')  -- narrowed per table below
  )
);
```

Every policy begins with `school_id = current_school_id()` plus the profile-active check, then narrows by role and ownership.

### 5.2 Per-table intent

| Table | Client read policy | Client write policy |
| --- | --- | --- |
| schools | own school only | admin update of own school |
| profiles | own row; admin reads school members; invigilator reads names of students in own sessions | admin writes; user updates own name |
| memberships | own rows; admin reads school rows | admin writes |
| classes | school rows; admin all, invigilator/student restricted set | admin writes |
| class_enrollments | admin all; invigilator rows for own sessions; student own | admin writes |
| exams | admin all; invigilator exams of assigned sessions; student assigned exams | admin writes |
| exam_form_links | none for clients | none for clients (service role only) |
| exam_assignments | admin all; invigilator own-session scope; student own | admin writes |
| exam_sessions | admin all; invigilator assigned; student sessions of assigned exams | admin writes |
| session_codes | none for clients (admin and invigilator use `session-control`) | none for clients |
| session_invigilators | admin all; invigilator own | admin writes |
| session_participants | admin all; invigilator own sessions; student own | admin and invigilator writes limited; student update limited (see note) |
| session_link_events | none for clients | none for clients (written by trusted functions only) |
| activity_events | admin all; invigilator own sessions; student own | student inserts own, client reported |
| audit_events | admin all; invigilator own sessions | none (append via trusted functions or a definer insert) |
| join_attempts | admin only (service role writes) | none for clients |
| login_identifiers | none for clients | none for clients (service role only, through Edge Functions) |
| login_attempts | admin only (service role writes) | none for clients |

Note on `session_participants`: a student's own write is limited to the acknowledgement step and is routed through `session-acknowledge`. If the student writes directly, only a narrow update of their own row for acknowledgement is allowed, guarded by a check that the row belongs to them and the session is open. Prefer routing this through the function. Link events are never written by a client role; they are written by `session-acknowledge` and `session-recover`.

### 5.3 Append-only enforcement for audit

- No `update` or `delete` policy exists for any client role on `audit_events`.
- A trigger raises an exception on update or delete, so even an accidental policy cannot modify a row.
- Inserts come from trusted functions using the service role, or from a `security definer` function that stamps the actor from `auth.uid()`.

### 5.4 Preventing policy recursion

The helper functions are `security definer` with `set search_path = public, pg_temp`, and they read `memberships` and `profiles` directly. This avoids a policy on `memberships` that queries `memberships`.

### 5.5 Role separation between anon and authenticated

- The anon role is used only for sign-in and for the QR landing page. It has no read access to tenant data.
- The authenticated role carries the user JWT and is filtered by the policies above.

---

## 6. Provisioning

Accounts are created by the administrator. There is no public self-registration.

### 6.1 Flow

```
Admin -> admin-provision { action: "create_user", full_name, role, school_id,
                            email (staff) | nisn (student), native_identifier }
admin-provision:
  1. Authorize: caller must be an active school_admin of school_id
  2. Generate a unique random initial password for the account
  3. Create the Auth user (service role) with the real native identifier
     and the initial password
  4. Insert or update profiles (status='active' or 'invited')
  5. Insert memberships (school_id, user_id, role, status='active')
  6. For a student, insert login_identifiers (school_id, nisn, user_id)
  7. Write an audit row (action=user.create)
  8. Return the initial password once to the administrator for out-of-band
     distribution; never store or return it again
```

- The native identifier for a student is a real, school-controlled value. Fabricated email addresses are not permitted. Which native identifier is used is an open decision (section 12).
- Bulk provisioning is a batch of the same call with per-item results.
- Role and alias changes are audited.
- Disabling is `profiles.status='disabled'` plus membership `status='suspended'`. This blocks portal data even if an Auth session is still valid, because the predicates return false.

### 6.2 Invariants

- A membership row requires an existing profile and school.
- A student membership should also have at least one enrollment or assignment before exams are published to them, enforced by workflow rather than by a hard constraint.
- The last active `school_admin` of a school cannot be disabled. Enforced by a check before the write.
- A student account has exactly one active `login_identifiers` row per school, and the NISN is unique within the school.

### 6.3 Student credentials and NISN login

Authentication authority: Supabase Auth verifies passwords. The portal never stores or checks a plaintext password.

Provisioning:

- The administrator creates the account and the system generates a unique random initial password.
- The initial password is shown to the administrator once for out-of-band distribution. It is not stored in the portal and not shown again.
- The session-authenticated student login flow is defined in `ARCHITECTURE.md` section 2.5.

Login flow (`auth-login`):

1. Rate limit by HMAC(NISN) and source address.
2. Resolve NISN to `user_id` and the native identifier through `login_identifiers` (service role).
3. Reject if the alias is missing or revoked, or the profile or membership is not active.
4. Call Supabase Auth `signInWithPassword` with the native identifier and the supplied password, server-side.
5. On success, return the session tokens and minimal profile data.
6. On failure, return a generic error, record a `login_attempts` row, and audit.

Requirements:

- NISN is an identifier, not a secret. It must not be used as a password or as a recovery secret.
- Failures return the same generic message whether the NISN exists or not, to limit enumeration.
- Login attempts are rate limited per NISN and per source, with a short lockout after repeated failures.
- The native identifier and the plaintext password are never logged or returned to the browser.

Open decisions (not yet approved):

- Password length and character set. The historical six-letter format is context only and is not mandated.
- Whether a forced password change at first sign-in is required.
- How initial passwords are distributed out-of-band.
- How account and password recovery is handled and verified.

---

## 7. Trusted operations and their checks

Every Edge Function verifies the caller before acting.

| Function | Checks before acting | Result |
| --- | --- | --- |
| `auth-login` | Unauthenticated by design; rate limit by HMAC(NISN) and source; resolve NISN to an active account; verify the password through Supabase Auth; deny if the profile or membership is not active | Returns a session on success; generic deny otherwise; audited |
| `session-join` | Valid JWT; active profile and membership (student); session belongs to an exam in the caller's school; `is_assigned_student`; exam published; `session_effective_status='open'`; code hash matches an unexpired, unrevoked code; participant not removed; rate limits clear | Upserts participant as joined, writes audit. Does not return the form link |
| `session-acknowledge` | Valid JWT; active profile and membership (student); participant exists and is joined or acknowledged; session is still open; rate limits clear | Records the acknowledgement and the first release (idempotent), writes audit, returns the form link |
| `session-recover` | Valid JWT; active profile and membership (student); participant is released and not removed; `can_recover_link(session)` is true; rate limits clear | Re-issues the previously released form link (idempotent), writes audit; denies at or after the grace boundary |
| `session-control` | Valid JWT; admin of the school, or `is_session_invigilator` for the target session | Revoke code, close session, remove participant, extend window, record incident; each writes audit |
| `admin-provision` | Valid JWT; `is_school_admin` | Create users, memberships, invites; writes audit |
| `report-export` | Valid JWT; admin, or `is_session_invigilator` for the session | Returns a signed CSV; writes audit |

Rules for all functions:

- Verify the JWT signature and expiry server-side.
- Never trust a `school_id` or `role` sent by the client. Derive them from the token and database.
- Fail closed. On any missing check, deny and return a reason.
- Write an audit row for allow and deny outcomes on security-relevant actions.

---

## 8. The join, acknowledgement, and link-recovery sequence

The student flow is ordered and each step is server-validated. No step returns the form link before its prerequisites hold.

1. `session-join`: validates eligibility, creates or updates the participant as `joined`, writes audit. It does not return the form link.
2. `session-acknowledge`: the student accepts the exam rules. The rules text comes from the exam's `instructions` (readable by assigned students). The acknowledgement is recorded once as `session_participants.acknowledged_at`, with a `session_link_events` row (event_type `acknowledged`) and an audit row. The server also records the first release (`released_at`, event_type `released`). Only after this succeeds does the server return the form link.
3. `session-recover`: re-issues the previously released form link. It is allowed while the session is open and, after the session ends, only strictly before the grace boundary. It records a `session_link_events` row (event_type `recovered`) and an audit row.

Idempotency: `session_link_events` has a unique key on `(participant_id, event_type, idempotency_key)`, so retrying any step cannot create a duplicate acknowledgement or a duplicate logical release event. `acknowledged_at` and `released_at` are set once and never overwritten.

Boundary and limits: the grace boundary is computed on the server from the session end and the configured duration. Recovery at or after the boundary is denied, and a retry cannot bypass it. The portal cannot revoke a Google Forms URL already revealed to a browser; recovery only controls whether the server re-issues the link.

---

## 9. Service-role and secret handling

- The service-role key exists only in Edge Function secrets and in local development secrets that are not committed.
- The browser build contains only the Supabase URL and the anon key.
- Build-time checks and code review confirm no service key is imported into frontend code.
- The code pepper and the code encryption key live only in Edge Function secrets. The database stores only the hash and the ciphertext.
- The login pepper, used to compute `login_attempts.nisn_hash`, lives only in Edge Function secrets.
- No plaintext password is ever stored by the portal. Passwords exist only as hashes inside Supabase Auth.

---

## 10. Audit and accountability

- Actor, role, school, action, target, result, reason, and a small metadata object are recorded.
- Metadata never contains plaintext codes, the form URL, or exam answers.
- Administrators can read all audit rows for their school. Invigilators can read audit rows tied to their sessions only.
- Reports surface participant timelines and recorded incidents. Activity signals are labeled as weak indicators (see `THREAT_MODEL.md` and `PROJECT_SPEC.md`).

---

## 11. Access control acceptance tests

1. A student token querying `exam_form_links` and `session_codes` returns zero rows.
2. A student token querying another student's `session_participants` row returns zero rows.
3. An invigilator token querying a session they are not assigned to returns zero rows.
4. A token for school A returns zero rows from every table for school B.
5. A disabled profile token returns zero rows from every tenant table.
6. An unauthenticated (anon) token returns zero rows from every tenant table.
7. Call the `session-join` function with a forged `school_id` in the body; it is ignored and the token's real school is used.
8. Call `session-control` as a student; it is denied and audited.
9. Attempt to update or delete an `audit_events` row as any client role; it is denied.
10. Sign in with a valid Auth session but a suspended membership; no tenant data is returned.
11. Sign in as a student with NISN and the correct password; a session is issued.
12. Sign in with NISN and a wrong password; denied with a generic error and a `login_attempts` row.
13. Sign in with NISN alone (no password); rejected by both the client and the server.
14. Repeated failed sign-ins for one NISN trigger rate limiting or a lockout.
15. A disabled account cannot sign in even with the correct password.
16. A student token reading `login_identifiers` or `login_attempts` returns zero rows.
17. The `auth-login` response never contains the native identifier or the plaintext password.
18. Call `session-join` with valid inputs; the response contains no form link.
19. Call `session-acknowledge`; the link is returned only after the acknowledgement is recorded.
20. Repeat `session-acknowledge` with the same idempotency key; no second release event is created.
21. `session-recover` returns the link before the grace boundary and is denied exactly at and after the boundary.
22. `session-recover` is denied for a removed participant, regardless of timing.
23. No retry of join, acknowledge, or recovery returns the form link after the grace boundary.

---

## 12. Open questions

1. Whether an invigilator should be allowed to extend a session's join window, or only an administrator.
2. Whether a student may hold both `student` and another role at the same school, and how role switching is presented.
3. The exact rules text students must acknowledge, and whether it is per school or per exam.
4. Whether profile `full_name` should be visible to invigilators across the whole school or only within their sessions.
5. Whether CSV export should require a separate permission or be part of the reporting role.
6. The native Supabase Auth identifier for student accounts (school-issued email, phone, or another approved scheme), since fabricated email addresses are not permitted. This blocks M3.
7. Password length and character set, and whether a forced change at first sign-in is required.
8. How initial passwords are distributed out-of-band and how account and password recovery is handled and verified.
9. Login rate-limit values (per NISN and per source) and the lockout duration.
10. Who is authorized to configure the link-recovery grace-period duration.
11. Whether a manual session close changes the grace-period calculation.
12. Whether recovery is exposed while a session is still open, or only after it ends.
