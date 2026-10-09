# DATABASE_DESIGN.md

Secure Exam Portal, database design.

Status: draft specification. No migration has been applied. No application code exists yet.

Companion documents: `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `RELIABILITY_AND_SCALE.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Design principles

1. Tenant-aware from migration one. Every tenant-owned row carries `school_id uuid not null`.
2. UUID primary keys everywhere, generated with `gen_random_uuid()`.
3. Foreign keys with explicit delete behavior. No orphan rows.
4. Check constraints encode the allowed status sets.
5. Row Level Security enabled on every table reachable by the anon or authenticated role.
6. Query-appropriate indexes, led by `school_id` where access is tenant-scoped.
7. Secrets (the Google Forms URL, session code material) live in tables or columns no student policy can read.
8. Append-only audit. No client role can update or delete audit rows.
9. Timestamps are `timestamptz`, stored in UTC. Server time is authoritative.

---

## 2. Entity-relationship diagram

```
schools 1 ---------- * memberships * ---------- 1 profiles
   |                                                    |
   |                                                    | (auth.users 1:1 profiles)
   |                                                    |
   | 1..* classes 1 ---- * class_enrollments * ---- 1 profiles (student)
   |
   | 1..* exams 1 ---- * exam_assignments
   |        |              |  (scope=class -> classes)
   |        |              |  (scope=student -> profiles)
   |        |
   |        | 1 ---- 1 exam_form_links        (protected, no client policy)
   |        |
   |        | 1 ---- * exam_sessions 1 ---- * session_codes       (protected hash/enc)
   |                     |            1 ---- * session_invigilators * ---- 1 profiles
   |                     |            1 ---- * session_participants * ---- 1 profiles (student)
   |                     |                          |
   |                     |                          | 1 ---- * activity_events
   |                     |                          | 1 ---- * session_link_events
   |                     |
   |                     +---- (denormalized) ---- audit_events
   |
   +------------------------------------------- audit_events
   +------------------------------------------- join_attempts
   +--- * login_identifiers * --- 1 profiles   (NISN alias, protected)
   +------------------------------------------- login_attempts
```

Text summary:

- A school has many memberships and many profiles are linked through them.
- A school has many classes; a class has many enrollments to students.
- A school has many exams; an exam has one protected form link and many assignments.
- An assignment targets a class or a student.
- An exam has many sessions; a session has codes, invigilators, and participants.
- A participant has many activity events and many link events (acknowledgement, release, recovery).
- The grace period for link recovery is a session setting distinct from the join window and the exam duration. See `exam_sessions.link_recovery_grace_minutes`.
- Audit events and join attempts reference the school and, when relevant, the session.
- A school has many login identifiers, each mapping one NISN to one profile. Login attempts record sign-in activity for rate limiting and forensics.

---

## 3. Enumerations

Implemented as `text` columns with `check` constraints rather than Postgres enums, so values can be extended without an enum migration.

| Name | Values |
| --- | --- |
| school_status | active, suspended |
| profile_status | invited, active, disabled |
| membership_role | school_admin, invigilator, student |
| membership_status | active, suspended |
| class_status | active, archived |
| enrollment_status | active, removed |
| exam_status | draft, published, completed, archived, cancelled |
| assignment_scope | class, student |
| assignment_status | active, revoked |
| session_state | scheduled, closed, cancelled (persisted, manual) |
| session_effective_status | scheduled, open, expired, closed, cancelled (derived) |
| participant_status | invited, joined, acknowledged, released, completed, expired, removed |
| activity_event_type | tab_hidden, tab_visible, window_blur, window_focus, visibility_change |
| audit_result | allow, deny, success, error |
| login_alias_status | active, revoked |
| link_event_type | acknowledged, released, recovered |

The derived `session_effective_status` is produced by a SQL function, not stored. See section 6.

---

## 4. Tables

Column types shown for the important fields. All tables have `created_at timestamptz not null default now()` unless noted, and `updated_at timestamptz not null default now()` where rows change.

### 4.1 schools

The tenant root.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK, default gen_random_uuid() |
| name | text not null | |
| slug | text not null | unique, URL-safe |
| status | text not null | check in school_status, default 'active' |
| created_at, updated_at | timestamptz | |

Indexes: unique index on `slug`.

### 4.2 profiles

One row per authenticated account. Global, not tenant-owned. A person can belong to more than one school through memberships.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK, references auth.users(id) on delete cascade |
| full_name | text | |
| email | text (nullable) | staff email for admin listing; nullable for students who have no email |
| status | text not null | check in profile_status, default 'invited' |
| created_at, updated_at | timestamptz | |

Indexes: index on `status`, index on `email`.

The NISN login alias for a student is not stored here. It lives in `login_identifiers`, scoped by school.

Note: `status='disabled'` must block portal data access even when the Auth session exists. Enforced in RLS helper (section 7).

### 4.3 memberships

Links a profile to a school with a role.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| user_id | uuid not null | references profiles(id) on delete cascade |
| role | text not null | check in membership_role |
| status | text not null | check in membership_status, default 'active' |
| created_at, updated_at | timestamptz | |

Constraints: unique (school_id, user_id, role).
Indexes: (user_id, school_id), (school_id, role, status).

### 4.4 classes

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| name | text not null | |
| code | text | short human label, optional |
| status | text not null | check in class_status, default 'active' |
| created_by | uuid | references profiles(id) on delete set null |
| created_at, updated_at | timestamptz | |

Constraints: unique (school_id, name).
Indexes: (school_id, status).

### 4.5 class_enrollments

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| class_id | uuid not null | references classes(id) on delete cascade |
| student_id | uuid not null | references profiles(id) on delete cascade |
| status | text not null | check in enrollment_status, default 'active' |
| created_at | timestamptz | |

Constraints: unique (class_id, student_id).
Indexes: (student_id, status), (class_id, status).

### 4.6 exams

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| title | text not null | |
| subject | text | |
| instructions | text | shown before acknowledgement |
| duration_minutes | integer | check > 0 |
| status | text not null | check in exam_status, default 'draft' |
| created_by | uuid | references profiles(id) on delete set null |
| published_at | timestamptz | set when status becomes published |
| created_at, updated_at | timestamptz | |

Indexes: (school_id, status), (school_id, created_at desc).

The Google Forms URL is intentionally not a column here. It lives in `exam_form_links`.

### 4.7 exam_form_links (protected)

Holds the Google Forms URL. No policy grants any access to the anon or authenticated role. Only the service role reads it, and only inside Edge Functions.

| Column | Type | Notes |
| --- | --- | --- |
| exam_id | uuid | PK, references exams(id) on delete cascade |
| school_id | uuid not null | references schools(id) on delete cascade (for scoping and audit) |
| form_url | text not null | the Google Forms URL |
| updated_by | uuid | references profiles(id) on delete set null |
| created_at, updated_at | timestamptz | |

RLS: enabled, with zero permissive policies for client roles. Access is service-role only.

### 4.8 exam_assignments

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| exam_id | uuid not null | references exams(id) on delete cascade |
| scope | text not null | check in assignment_scope |
| class_id | uuid | references classes(id) on delete cascade, nullable |
| student_id | uuid | references profiles(id) on delete cascade, nullable |
| status | text not null | check in assignment_status, default 'active' |
| created_by | uuid | references profiles(id) on delete set null |
| created_at | timestamptz | |

Constraints:

- `(scope='class' and class_id is not null and student_id is null) or (scope='student' and student_id is not null and class_id is null)`.
- Unique (exam_id, class_id) where scope='class'.
- Unique (exam_id, student_id) where scope='student'.

Indexes: (exam_id, status), (class_id), (student_id), (school_id).

### 4.9 exam_sessions

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| exam_id | uuid not null | references exams(id) on delete cascade |
| name | text | label such as room or sitting |
| starts_at | timestamptz not null | join window opens |
| join_closes_at | timestamptz not null | join window closes |
| ends_at | timestamptz | session ends, >= join_closes_at |
| link_recovery_grace_minutes | integer | nullable; minutes after session end during which a released link may be recovered. Null means no post-session recovery. Distinct from the join window and the exam duration. The reference point for session end (scheduled end versus actual close time) is an open decision (section 11). |
| state | text not null | check in session_state, default 'scheduled' |
| closed_by | uuid | references profiles(id) on delete set null |
| created_by | uuid | references profiles(id) on delete set null |
| created_at, updated_at | timestamptz | |

Constraints: `join_closes_at > starts_at`, `ends_at is null or ends_at >= join_closes_at`, `link_recovery_grace_minutes is null or link_recovery_grace_minutes >= 0`.

Indexes: (exam_id, starts_at), (school_id, starts_at), (school_id, state).

### 4.10 session_codes (protected)

Holds code material. Two representations so validation is fast and authorized display is possible. Neither is readable by students.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| session_id | uuid not null | references exam_sessions(id) on delete cascade |
| code_hash | text not null | HMAC-SHA256(code, pepper), hex. Used for lookup. |
| code_encrypted | text not null | AES-GCM ciphertext of the code, base64. Decrypted only by session-control for authorized display. |
| expires_at | timestamptz not null | must be <= session join_closes_at |
| revoked_at | timestamptz | set on revoke |
| max_uses | integer | optional cap |
| use_count | integer not null default 0 | |
| created_by | uuid | references profiles(id) on delete set null |
| created_at | timestamptz | |

Constraints: unique (code_hash).
Indexes: unique (code_hash), (session_id, revoked_at).

Pepper and encryption key are Edge Function secrets, never in the database and never in the browser.

### 4.11 session_invigilators

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| session_id | uuid not null | references exam_sessions(id) on delete cascade |
| invigilator_id | uuid not null | references profiles(id) on delete cascade |
| created_at | timestamptz | |

Constraints: unique (session_id, invigilator_id).
Indexes: (invigilator_id, session_id).

### 4.12 session_participants

The idempotency anchor for joins.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| session_id | uuid not null | references exam_sessions(id) on delete cascade |
| student_id | uuid not null | references profiles(id) on delete cascade |
| status | text not null | check in participant_status, default 'invited' |
| joined_at | timestamptz | set by `session-join` |
| acknowledged_at | timestamptz | set once on first acknowledgement; never overwritten |
| released_at | timestamptz | set once on first release; never overwritten |
| recovered_at | timestamptz | last successful recovery of the link |
| completed_at | timestamptz | |
| removed_at | timestamptz | |
| removed_by | uuid | references profiles(id) on delete set null |
| release_count | integer not null default 0 | incremented only for a genuine release or recovery, never for a repeat of the same request |
| created_at, updated_at | timestamptz | |

Constraints: unique (session_id, student_id).
Indexes: (session_id, status), (student_id), unique (session_id, student_id).

This row is the idempotency anchor for `session-join` and `session-acknowledge`. Repeating a join or acknowledgement does not create a second participant row or overwrite `acknowledged_at` or `released_at`. Per-request release and recovery idempotency is recorded in `session_link_events` (written by `session-acknowledge` and `session-recover`).

### 4.13 activity_events

Weak behavioral signals. Best effort, client reported, server timestamped.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| session_id | uuid not null | references exam_sessions(id) on delete cascade |
| participant_id | uuid not null | references session_participants(id) on delete cascade |
| student_id | uuid not null | references profiles(id) on delete cascade |
| event_type | text not null | check in activity_event_type |
| client_seq | bigint not null | monotonic per client, for deduplication |
| client_time | timestamptz | optional, client clock, untrusted |
| occurred_at | timestamptz not null default now() | server receipt time |
| metadata | jsonb | small, no free text of exam content |

Constraints: unique (participant_id, client_seq).
Indexes: (session_id, occurred_at), (session_id, event_type).

### 4.14 audit_events (append-only)

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| actor_id | uuid | references profiles(id) on delete set null, null for system |
| actor_role | text | snapshot of role at action time |
| action | text not null | e.g. session.join.allow, code.revoke |
| target_type | text not null | e.g. session, participant, exam |
| target_id | uuid | |
| session_id | uuid | denormalized for query |
| result | text | check in audit_result |
| reason | text | machine-readable denial reason |
| metadata | jsonb | small structured detail, no secrets, no plaintext codes |
| created_at | timestamptz not null default now() | |

Indexes: (school_id, created_at desc), (session_id, created_at desc), (actor_id, created_at desc), (action, created_at desc).

No update or delete is permitted to any client role. A trigger can additionally raise on update and delete.

### 4.15 join_attempts

Backs rate limiting and forensic queries. Separate from audit for query speed.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid | references schools(id) on delete cascade, nullable if unresolved |
| session_id | uuid | references exam_sessions(id) on delete set null, nullable |
| student_id | uuid | references profiles(id) on delete set null, nullable |
| source_hash | text | HMAC of the source address, never the raw address |
| attempted_code_hash | text | HMAC of the attempted code, never plaintext |
| result | text | check in audit_result |
| reason | text | |
| created_at | timestamptz not null default now() | |

Indexes: (session_id, created_at desc), (student_id, created_at desc), (source_hash, created_at desc).

A retention job deletes rows older than a short window (for example 24 hours) to keep this table small and to limit data retention.

### 4.16 login_identifiers (protected)

Maps a student's NISN to the account that owns it. This is the server-side login alias used by `auth-login`. NISN is an identifier, not a secret, but the mapping is kept service-role only to avoid client enumeration of accounts.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| user_id | uuid not null | references profiles(id) on delete cascade |
| nisn | text not null | the student's NISN login alias |
| status | text not null | check in login_alias_status, default 'active' |
| created_by | uuid | references profiles(id) on delete set null |
| created_at, updated_at | timestamptz | |

Constraints: unique (school_id, nisn), unique (school_id, user_id).
Indexes: unique (school_id, nisn), (user_id).
RLS: enabled, no policy for any client role. Reads and writes are service-role only, through Edge Functions.

### 4.17 login_attempts

Backs login rate limiting and forensic queries. Mirrors `join_attempts`. No plaintext NISN or password is stored.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid | references schools(id) on delete cascade, nullable if unresolved |
| user_id | uuid | references profiles(id) on delete set null, nullable |
| nisn_hash | text | HMAC-SHA256(NISN, pepper), hex. Never plaintext. |
| source_hash | text | HMAC of the source address, never the raw address |
| result | text | check in audit_result |
| reason | text | |
| created_at | timestamptz not null default now() | |

Indexes: (nisn_hash, created_at desc), (source_hash, created_at desc).

A retention job deletes rows older than a short window (for example 24 hours), matching `join_attempts`.

### 4.18 session_link_events

Records the acknowledgement, release, and recovery events for a participant. The unique key on `(participant_id, event_type, idempotency_key)` makes each client request idempotent so a retry cannot create a duplicate logical release event.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | PK |
| school_id | uuid not null | references schools(id) on delete cascade |
| session_id | uuid not null | references exam_sessions(id) on delete cascade |
| participant_id | uuid not null | references session_participants(id) on delete cascade |
| student_id | uuid not null | references profiles(id) on delete cascade |
| event_type | text not null | check in link_event_type |
| idempotency_key | text not null | client-supplied per request; never reused for a different request |
| occurred_at | timestamptz not null default now() | server receipt time |
| metadata | jsonb | small; no form URL, no secrets |

Constraints: unique (participant_id, event_type, idempotency_key).
Indexes: (session_id, occurred_at), (participant_id), (session_id, event_type).

RLS: enabled with no permissive policy for any client role. Rows are written and read by trusted functions only.

---

## 5. Relationships and referential actions

| Parent | Child | On delete |
| --- | --- | --- |
| schools | memberships, classes, exams, and all tenant rows | cascade |
| profiles | memberships, enrollments, participants, activity_events | cascade |
| profiles | created_by, closed_by, removed_by, actor_id, updated_by references | set null |
| profiles | login_identifiers | cascade |
| schools | login_identifiers, login_attempts | cascade |
| exams | exam_form_links, exam_assignments, exam_sessions | cascade |
| exam_sessions | session_codes, session_invigilators, session_participants | cascade |
| session_participants | activity_events, session_link_events | cascade |
| exam_sessions | session_link_events | cascade |

Deleting a school is destructive and reserved for an administrative cleanup path. Normal operations archive or cancel rather than delete.

---

## 6. Server-side functions

Trusted SQL functions used by RLS policies and Edge Functions. Marked `security definer` with a fixed search path to avoid policy recursion.

| Function | Purpose |
| --- | --- |
| `current_membership_id()` | Returns the active membership id for `auth.uid()` in the requested school. |
| `current_school_id()` | Returns the caller's active school id. |
| `current_role()` | Returns the caller's role in the active school. |
| `is_school_admin(school uuid)` | True when the caller is an active admin of that school. |
| `is_session_invigilator(session uuid)` | True when the caller is an assigned invigilator of that session. |
| `session_effective_status(session uuid)` | Derives scheduled/open/expired/closed/cancelled from `starts_at`, `join_closes_at`, and `state`, using server time. |
| `session_recovery_grace_end(session uuid)` | Returns the server-side instant when the link-recovery grace period ends, computed from the session end plus `link_recovery_grace_minutes`. Null when no recovery is configured. |
| `can_recover_link(session uuid)` | True when the session is open, or the session has ended and server time is strictly before `session_recovery_grace_end`. Used by `session-recover`. |
| `is_assigned_student(exam uuid)` | True when the caller is assigned to the exam directly or through an active class enrollment. |

These functions are the single definition of authorization predicates. RLS policies and Edge Functions call the same predicates so client and server agree.

Important: `session_effective_status` and `is_assigned_student` must be computed on the server. The client only displays the result.

NISN resolution is not a client-callable SQL function. The `auth-login` Edge Function reads `login_identifiers` with the service role and resolves the alias before calling Supabase Auth. No RLS policy exposes the table to clients.

---

## 7. Tenant isolation and RLS summary

Full policy text is in `ACCESS_CONTROL.md`. The shape here:

- Every tenant table has RLS enabled.
- A `school_id` must equal `current_school_id()` for any row a client can see.
- Students additionally see only their own participant and activity rows, only exams assigned to them, and only sessions of those exams.
- Invigilators see only sessions where `is_session_invigilator(session)` is true, plus the participants and activity of those sessions.
- Administrators see all rows for their school.
- `exam_form_links`, `session_codes`, and `login_identifiers` have no client policies at all. Client reads return zero rows.
- `login_attempts` has no client policy. It is written and read by trusted functions only.
- `session_link_events` has no client policy. It is written and read by trusted functions only.
- A disabled profile (`profiles.status='disabled'`) or suspended membership yields no active membership, so all policies deny.

---

## 8. Index strategy

Indexes are chosen for the access paths of the three roles and for load-test queries.

- Tenant scoping: leading `school_id` on list queries (exams, classes, sessions, audit).
- Student lists: `exam_assignments(student_id)`, `session_participants(student_id)`.
- Join path: unique `session_codes(code_hash)` for the single lookup that validates a code, and unique `session_participants(session_id, student_id)` for the idempotent upsert.
- Link events: unique `session_link_events(participant_id, event_type, idempotency_key)` so acknowledgement, release, and recovery retries are idempotent.
- Live invigilator view: `session_participants(session_id, status)` and `activity_events(session_id, occurred_at)`.
- Rate limiting: `join_attempts` indexes on (session_id, created_at), (student_id, created_at), (source_hash, created_at).
- Audit browsing: `audit_events(school_id, created_at desc)` and `(session_id, created_at desc)`.
- Retention: a partial index or scheduled deletion uses `join_attempts(created_at)`.

Every foreign key has a supporting index to keep cascades and joins fast.

---

## 9. Migration strategy

- Tooling: Supabase CLI with a `supabase/migrations` directory and numbered SQL files, applied forward only.
- Ordering: one logical change per migration, named with a UTC timestamp prefix.
- Base set of migrations in order:
  1. Extensions and helper schema (`pgcrypto` for `gen_random_uuid` and HMAC helpers).
  2. `schools`, `profiles`, `memberships`, `login_identifiers` and their policies and helper functions.
  3. `classes`, `class_enrollments` and policies.
  4. `exams`, `exam_form_links`, `exam_assignments` and policies.
  5. `exam_sessions`, `session_codes`, `session_invigilators`, `session_participants`, `session_link_events` and policies.
  6. `activity_events`, `audit_events`, `join_attempts`, `login_attempts` and policies.
  7. Functions: `session_effective_status`, `is_assigned_student`, rate-limit helpers.
  8. Seed data for development only (one school, sample classes, an admin, a fake form URL that points at a placeholder, not a real exam).

- Rules: no manual schema edits in production; every migration is reviewed; staging is migrated before production; a rollback plan exists per migration (a forward fix, since destructive down migrations are discouraged).
- Multi-tenant from migration one: `school_id` is present on every tenant table in its first creation, not added later.
- Seed data must clearly mark the placeholder form URL so it is never mistaken for a real exam.

---

## 10. Data retention

- `audit_events`: retained for the school's policy. Retention length is an open question because it competes with free-tier storage.
- `join_attempts`, `login_attempts`, and `activity_events`: retained for a short window (for example 24 to 72 hours) or per the school's policy, then deleted by a scheduled job.
- `session_participants` and reports: retained as academic records.
- `login_identifiers`: retained while the account is active; removed or revoked when a student leaves.
- No tables store question text, answers, plaintext passwords, or plaintext NISN in the attempt log.

---

## 11. Open questions

1. Supabase plan and region, which set the physical limits for storage and egress.
2. Audit retention length against storage limits.
3. Whether `code_encrypted` is required in the MVP, or whether codes are displayed once at generation and never re-shown (which would allow hash-only storage).
4. Whether activity events are stored for every session or sampled, given write volume at 1,500 concurrent students.
5. Whether a separate `rate_limit_counters` table is needed in addition to `join_attempts` for high-frequency smoothing, and the same for `login_attempts`.
6. Whether row-level security should also be enforced on any future analytics or export table.
7. The native Supabase Auth identifier stored on each student account (school-issued email, phone, or another approved scheme), given that fabricated email addresses are not permitted.
8. Whether `login_identifiers` should store a normalized NISN form (trimmed, digits only) and how duplicates are rejected at import time.
9. Whether revoked `login_identifiers` rows are kept for audit or hard-deleted.
10. Who is authorized to configure `link_recovery_grace_minutes` (administrator, school settings, or higher).
11. Whether the grace period is measured from the scheduled session end or from the actual manual close time.
12. Whether `link_recovery_grace_minutes` lives on the session, on the exam, or in school settings.
13. Whether `session_link_events` rows are covered by the same short retention window as `activity_events`, or retained as academic records with the participant.
