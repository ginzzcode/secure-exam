# IMPLEMENTATION_PLAN.md

Secure Exam Portal, implementation plan and completion gates.

Status: draft specification. No application code exists yet, and none is created by this document. This plan starts only after the specification set is approved.

Companion documents: `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `RELIABILITY_AND_SCALE.md`.

---

## 1. How to read this plan

- Work is grouped into milestones. Each milestone has a goal, deliverables, dependencies, test requirements, and a completion gate.
- A milestone is done only when its gate passes with evidence. Intent is not completion.
- No milestone that writes application code begins until the documentation set is approved and the open questions that block it are resolved.
- A milestone is not approved, and its gate does not pass, while any decision that blocks that milestone remains unresolved. Different milestones have different blocking decisions; see section 5.
- The first milestone is decisions and environment, not features.

---

## 2. Milestone overview

| ID | Milestone | Depends on | Produces code? |
| --- | --- | --- | --- |
| M0 | Approve specification and resolve blocking questions | none | No |
| M1 | Provision environments and project skeleton | M0 | Yes (tooling only, no features) |
| M2 | Database schema, RLS, and helper functions | M1 | Yes (SQL only) |
| M3 | Authentication and provisioning | M2 | Yes |
| M4 | Admin: classes, exams, assignments, sessions | M3 | Yes |
| M5 | Session code, join, acknowledgement, and link recovery | M4 | Yes |
| M6 | Student and invigilator experiences | M5 | Yes |
| M7 | PWA shell, error states, activity signals | M6 | Yes |
| M8 | Reports, exports, and audit views | M7 | Yes |
| M9 | Load test, security review, and release | M8 | Tests and fixes |

---

## 3. Milestones in detail

### M0: Approve specification and resolve blocking questions

Goal: lock the specification and answer the questions that change architecture or schema.

Deliverables:

- All seven documents reviewed and approved.
- Decisions recorded for the blocking open questions listed in section 5.
- A single decisions log appended to `PROJECT_SPEC.md` or a new `docs/DECISIONS.md` (creation of a decisions file is optional and requires approval, because only the seven named documents were requested).

Blocking decisions are grouped by the milestone they block. They are not all required for M0 approval.

Decisions required before M1 (project skeleton):

- Frontend host.
- Supabase region and plan.

Decisions required before M3 (authentication):

- Student sign-in is decided as NISN plus a school-issued password. Still blocking for M3: the native Supabase Auth identifier per student account (school-issued email, phone, or another approved scheme), because fabricated email addresses are not permitted.
- Password length and character set, and whether a forced change at first sign-in is required.
- How initial passwords are distributed and how account and password recovery is handled and verified.
- Login rate-limit values and lockout duration.

Decisions required before M5 (form release and link recovery):

- Post-session link-recovery grace period: confirmed as a feature, but the school must set the duration. No default.
- Who is authorized to configure the grace-period duration.
- Whether a manual session close changes the grace-period calculation.
- Whether recovery is exposed while a session is still open.

Already decided (do not reopen):

- The Google Forms link is returned directly after authorization and acknowledgement. The logging redirect is deferred and not part of the MVP.

Completion gate:

- The decisions required before M1 are recorded, and no document contradicts another (see section 6).
- This gate clears M1. The M3 and M5 decisions are recorded before their own milestones and do not block M1.

### M1: Provision environments and project skeleton

Goal: a working project shell with no product features, plus staging and production environments.

Deliverables:

- Vite React JSX project initialized.
- Supabase staging and production projects created, region chosen.
- Local development environment documented and reproducible.
- Supabase CLI wired for migrations.
- Environment variables defined: only the Supabase URL and anon key reach the frontend.
- A build check that fails if a service key appears in the frontend bundle.
- CI skeleton: install, lint, build, and a placeholder test job.

Dependencies: M0.

Test requirements:

- Build succeeds.
- The bundle scan finds no service-role key.
- CI runs on a pull request.

Completion gate:

- The M1-blocking decisions (frontend host, Supabase region and plan) are recorded.
- The repository builds and the bundle scan passes.
- No product feature code exists yet.

### M2: Database schema, RLS, and helper functions

Goal: the full tenant-aware schema with policies, indexes, and helper functions from `DATABASE_DESIGN.md` and `ACCESS_CONTROL.md`.

Deliverables:

- Migrations for all tables, constraints, and indexes.
- RLS enabled on every client-accessible table.
- `exam_form_links` and `session_codes` with no client policy.
- Helper functions: `current_school_id`, `current_role`, `is_school_admin`, `is_session_invigilator`, `is_assigned_student`, `session_effective_status`, `profile_is_active`.
- Append-only trigger on `audit_events`.
- Development seed data with a clearly marked placeholder form URL.

Dependencies: M1.

Test requirements (pgTAP or SQL tests, run in CI):

- Every table in the tenant set has RLS enabled.
- Cross-tenant reads return zero rows.
- Student reads of `exam_form_links` and `session_codes` return zero rows.
- A disabled profile gets zero tenant rows.
- `session_effective_status` returns scheduled, open, and expired correctly across boundary times, using controlled timestamps.
- Audit update and delete are rejected.

Completion gate:

- All RLS and function tests pass in CI.
- No product UI is required for this gate.

### M3: Authentication and provisioning

Goal: administrators can create accounts and users can sign in with correct role resolution. Students sign in with NISN and a school-issued password; staff sign in with administrator-provisioned credentials.

Deliverables:

- Staff sign-in, sign-out, and session handling using Supabase Auth directly.
- `auth-login` function: rate limit, resolve NISN to the native identifier through `login_identifiers`, verify the password through Supabase Auth server-side, return a session, and audit.
- `admin-provision` function: create the Auth user with a real native identifier, set a unique random initial password, create profile and membership, and for a student insert a `login_identifiers` alias, write audit, and return the initial password once for out-of-band distribution.
- Password generation and initial-credential handling. The portal stores no plaintext password.
- Account and password recovery (design per the approved open decision).
- Disable and re-enable account.
- Role resolution on the client from memberships.
- Route guards by role, cosmetic only.
- A capability spike that confirms against the current Supabase documentation that the chosen native identifier, administrator user creation, and server-side password sign-in all work as expected.

Dependencies: M2. The M3-blocking decisions in section 5 (native identifier, password policy, forced change, distribution, recovery, and login rate limits) must be resolved before this milestone starts. M3 is not approved while any of them remain unresolved.

Test requirements:

- Provision a student with a NISN alias and sign in with NISN plus the correct password; a session is issued.
- Sign in with NISN and a wrong password; denied with a generic error and a `login_attempts` row.
- Repeated failures for one NISN trigger rate limiting or a lockout.
- The `auth-login` response never contains the native identifier or a plaintext password.
- A client cannot read `login_identifiers` or `login_attempts` (zero rows).
- A disabled profile cannot sign in and cannot read tenant data (integration test).
- A student role cannot reach admin routes, and the server denies admin calls regardless.
- Provisioning writes an audit row and does not retain the plaintext password.

Completion gate:

- An administrator can provision a student, invigilator, and admin, and each resolves to the correct role.
- A student signs in with NISN and the issued password; a wrong password and a NISN-only attempt are denied.
- Access control tests from `ACCESS_CONTROL.md` section 11, including the student sign-in tests, pass.

### M4: Admin features

Goal: administrators manage classes, enrollments, exams, assignments, and sessions.

Deliverables:

- Classes and enrollment screens.
- Exam creation with title, subject, instructions, duration, and form URL (written to the protected store through a trusted path).
- Exam lifecycle transitions: draft, published, completed, archived, cancelled.
- Assignments to classes and to students.
- Session scheduling with start, join close, and end times.
- Invigilator assignment to sessions.

Dependencies: M3.

Test requirements:

- Publishing an exam makes it visible to assigned students only.
- Saving a form URL writes an audit row and does not expose the URL to student queries.
- Session time constraints reject invalid windows.
- Assignments reject out-of-school targets.

Completion gate:

- An administrator can prepare a full exam with assignments and sessions and publish it.
- The form URL is not readable by a student token.

### M5: Session code, join, acknowledgement, and link recovery

Goal: the critical path. A student joins an open session, acknowledges the rules, receives the form link, and can recover a previously released link only within the session or grace policy.

Deliverables:

- Code generation (hash plus ciphertext), expiry, revocation, and authorized display.
- `session-join` function: eligibility and code checks, idempotent participant upsert to `joined`, audit. It does not return the form link.
- `session-acknowledge` function: records the acknowledgement once, records the first release once, writes audit and a `session_link_events` row, and returns the form link.
- `session-recover` function: re-issues a previously released form link after revalidating identity, active profile and membership, school, assignment, participant status, and the session or grace policy. Idempotent.
- `session_link_events` table backing idempotent acknowledgement, release, and recovery events.
- Rate limiting backed by `join_attempts`, plus a recovery rate limit.
- Audit rows for allow and deny.
- The link-recovery grace-period boundary enforced server-side, using the reference point set by the M5 decisions. No default duration.
- The `form-redirect` logging proxy is deferred and is not part of the MVP.

Dependencies: M4. The M5-blocking decisions in section 5 (grace-period duration, who configures it, whether a manual close changes the calculation, and whether recovery is exposed while a session is open) must be resolved before this milestone starts. M5 is not approved while any of them remain unresolved.

Test requirements:

- The full eligibility matrix: each denial reason produces the correct outcome and audit row.
- Idempotency: duplicate and concurrent joins produce one participant row.
- `session-join` returns no form link; `session-acknowledge` returns the link only after the acknowledgement is recorded.
- Repeating acknowledge or recover does not create a duplicate release event.
- Code revocation and expiry take effect immediately.
- Rate limits trigger under a controlled burst.
- Server time governs open and expired, tested with controlled clocks.
- Grace boundary under controlled clocks: recovery succeeds before the boundary and is denied exactly at and after it.
- A retry of join, acknowledge, or recover cannot obtain the link after the grace boundary.
- Recovery is denied for a removed or disabled participant.
- A database dump check confirms no plaintext active code.

Completion gate:

- Every acceptance criterion in `PROJECT_SPEC.md` section 7 items 2, 3, 4, 7, and 8 passes, and the ordered join, acknowledgement, and recovery flow matches `ARCHITECTURE.md` section 3.3 and `ACCESS_CONTROL.md` section 8.
- No path returns the form URL without a full pass, and no path returns it before a successful acknowledgement.

### M6: Student and invigilator experiences

Goal: the user-facing portal for both roles.

Deliverables:

- Student: assigned exams list, status display, join form, acknowledgement, form link handoff, connection-error states.
- Invigilator: assigned sessions, live participant list, revoke code, close session, remove participant, record incident.
- Responsive layout verified on a 360 pixel phone and desktop.
- States: empty, loading, error for every data view.

Dependencies: M5.

Test requirements:

- Student sees only assigned exams.
- No form link before acknowledgement.
- Invigilator sees only assigned sessions; control actions are audited.
- Keyboard navigation and focus states on both flows.

Completion gate:

- A student can complete the join flow on a phone.
- An invigilator can run a session and record an incident.
- No horizontal overflow at 360 pixels.

### M7: PWA shell, error handling, and activity signals

Goal: installable shell, safe retries, and weak activity signals.

Deliverables:

- Manifest and service worker caching the static shell only.
- Offline fallback and connection-error states across the app.
- Retry with backoff and idempotency keys.
- Activity signal capture (visibility and focus), labeled as weak.
- A UI label stating Google Forms is online only and submissions are confirmed by Google Forms.

Dependencies: M6.

Test requirements:

- Service worker never caches a form URL or authenticated data.
- Offline load shows the shell and a connection-error state.
- A retried join does not create duplicates or double releases.
- Activity signals are recorded and displayed with the weak-signal label.

Completion gate:

- The app is installable and behaves correctly offline at the shell level.
- No misleading offline or lockdown claim appears anywhere in the UI.

### M8: Reports, exports, and audit views

Goal: post-exam reporting for administrators and invigilators.

Deliverables:

- Session report with participant timeline and recorded incidents.
- CSV export through `report-export` with a signed download and an audit row.
- Audit log view filtered by role.
- Activity signals shown as weak indicators, clearly distinguished from facts.

Dependencies: M7.

Test requirements:

- Report data matches the underlying rows.
- Export requires authorization and writes an audit row.
- Activity signals are labeled and never presented as proof.

Completion gate:

- An administrator can export a session report.
- Labels on activity data are present and correct.

### M9: Load test, security review, and release

Goal: prove the system against the plan and release honestly.

Deliverables:

- Load test at 1,500 virtual users per `RELIABILITY_AND_SCALE.md` section 6.
- Recorded results with environment description and pass or fail against the targets.
- Security review against `THREAT_MODEL.md` section 10 and `ACCESS_CONTROL.md` section 11.
- A release note that states the measured capacity, not the target.
- A runbook for session-day operation and incident response.

Dependencies: M8.

Test requirements:

- The full load-test scenario set runs.
- All security acceptance tests pass with evidence.
- A failure in any failure criterion in `RELIABILITY_AND_SCALE.md` section 6.6 blocks release until fixed or the claim is reduced.

Completion gate:

- Evidence exists for every acceptance criterion across all documents.
- The release note does not claim capacity beyond what was measured.

---

## 4. Dependency graph

```
M0 --> M1 --> M2 --> M3 --> M4 --> M5 --> M6 --> M7 --> M8 --> M9
```

The join path (M5) depends on the schema and provisioning. It is intentionally late enough that the data model is stable, and early enough that the hardest reliability work is not left to the end.

---

## 5. Blocking decisions by milestone

| Decision | Blocks | Source |
| --- | --- | --- |
| Frontend host | M1, M7, M9 | `ARCHITECTURE.md` open questions |
| Supabase region and plan | M1, M9 | `RELIABILITY_AND_SCALE.md` |
| Native Supabase Auth identifier for students (school-issued email, phone, or another approved scheme) | M3 | `ARCHITECTURE.md`, `PROJECT_SPEC.md` |
| Password length and character set | M3 | `PROJECT_SPEC.md` |
| Forced change at first sign-in | M3 | `PROJECT_SPEC.md` |
| Initial-credential distribution method | M3 | `ACCESS_CONTROL.md` |
| Account and password recovery method | M3 | `ACCESS_CONTROL.md` |
| Post-session link-recovery grace-period duration (no default) | M5 | `PROJECT_SPEC.md`, `ARCHITECTURE.md` |
| Who configures the grace-period duration | M5 | `ACCESS_CONTROL.md` |
| Whether a manual session close changes the grace-period calculation | M5 | `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md` |
| Whether recovery is exposed while a session is open | M5 | `ARCHITECTURE.md`, `ACCESS_CONTROL.md` |
| Login rate-limit values and lockout duration | M3 | `ACCESS_CONTROL.md`, `RELIABILITY_AND_SCALE.md` |
| Audit retention length | M2, M8 | `DATABASE_DESIGN.md` |
| Whether activity events are sampled | M7, M9 | `DATABASE_DESIGN.md` |
| Physical invigilation and device policy | Integrity claims | `THREAT_MODEL.md` |
| Whether a decisions file is allowed | M0 | This document |

---

## 6. Cross-document consistency check

Required before M0 gate passes.

| Check | Rule |
| --- | --- |
| Roles | Same three roles in every document: school_admin, invigilator, student. |
| Statuses | Exam, session, and participant status sets match `PROJECT_SPEC.md` and `DATABASE_DESIGN.md`. |
| Form URL protection | Described the same way in `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`. |
| Join, acknowledgement, and release order | `session-join` never returns the form link; `session-acknowledge` returns it only after the acknowledgement is recorded; `session-recover` re-issues it within the session or grace policy. Consistent in `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `ACCESS_CONTROL.md`, `RELIABILITY_AND_SCALE.md`. |
| Link recovery | Recovery revalidates identity, active profile and membership, school, assignment, participant status, and the session or grace policy, in `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `ACCESS_CONTROL.md`, `DATABASE_DESIGN.md`. |
| Grace boundaries | The grace period is distinct from the join window and exam duration; recovery is denied exactly at and after the boundary; the duration has no invented default. Stated in `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`. |
| Function naming | `session-control` is the only name for session control; the student link path uses `session-join`, `session-acknowledge`, and `session-recover`. Consistent across all documents. |
| Tenant model | `school_id` on every tenant row, stated in all relevant documents. |
| Server authority | Timing and eligibility always server-side, stated everywhere they appear. |
| Offline limits | No document promises offline Google Forms or device lockdown. |
| Student login | NISN plus a school-issued password, resolved server-side by `auth-login`, described the same way in `ARCHITECTURE.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `DATABASE_DESIGN.md`, and `PROJECT_SPEC.md`. NISN is never called a secret and never used as a password. |
| Auth vs authz | Every document keeps authentication (Supabase Auth) separate from authorization (RLS and Edge Function checks). |
| Grace period | Post-session link recovery is gated by a school-configured grace period with no invented default, in `PROJECT_SPEC.md`, `ARCHITECTURE.md`, and this document. |
| Native identifier | No document permits fabricated or synthetic email addresses for student accounts. |
| Load target | Always a plan or a target, never an achieved result, in every document. |
| Open questions | Each document's open questions appear in the consolidated list in `PROJECT_SPEC.md` section 12 or its own section. |

---

## 7. Definition of done (project)

1. All seven documents approved and consistent per section 6.
2. All acceptance criteria in `PROJECT_SPEC.md` section 7 have recorded evidence.
3. All access control tests in `ACCESS_CONTROL.md` section 11 pass.
4. All security tests in `THREAT_MODEL.md` section 10 pass.
5. All reliability tests in `RELIABILITY_AND_SCALE.md` section 9 pass.
6. The load test result is recorded with environment and pass or fail.
7. The release note states measured capacity and does not overclaim.
8. No service key or secret exists in the frontend bundle.
9. Offline and BYOD limitations are stated in the product, not only in documents.
10. Student sign-in works with NISN and the school-issued password; no table readable by a client reveals the native identifier mapping or a plaintext password, and the portal stores no plaintext password.
11. Join, acknowledgement, and recovery are server-validated and ordered: no join response contains the form link, and recovery is denied at and after the grace boundary.

---

## 8. Out of scope for this plan

- Writing any application code before M0 approval.
- Installing dependencies or modifying package manifests as part of this documentation task.
- Placeholder components or demo implementations.
- Native mobile apps, automated grading, payments, or real-time video proctoring.

---

## 9. Open questions

1. Who approves M0, and how is approval recorded?
2. Whether a `docs/DECISIONS.md` file is permitted, since only seven documents were requested.
3. The team size and timeline, which affect how milestones are parallelized.
4. Whether any milestone can be cut for a faster MVP, and which one.
5. The definition of a successful load-test pass that the school will accept.
6. The native Supabase Auth identifier for student accounts, and the password policy, distribution, and recovery decisions listed in section 5.
7. Who configures the link-recovery grace-period duration, and whether a manual session close changes the calculation, as listed in section 5.
