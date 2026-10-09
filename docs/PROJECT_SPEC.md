# PROJECT_SPEC.md

Secure Exam Portal, product specification.

Status: draft specification, awaiting review. No application code exists yet.

Companion documents: `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `RELIABILITY_AND_SCALE.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Purpose

The Secure Exam Portal is a web application that schedules school examinations, assigns them to classes and students, controls when a student may open the exam paper, and hands the student a link to a Google Form only after the student is verified as eligible at that moment.

The portal is an access gate and a record keeper. It is not the exam paper and not the response store. Questions and answers live in Google Forms. The portal decides who may reach that form, when, and records what happened.

The initial deployment serves one school. The database and authorization model are built for multiple schools from the first migration so a second school can be added without a redesign.

---

## 2. Scope summary

In scope for the MVP:

- Account provisioning by the school IT administrator (no public self-registration), including student login with NISN and a school-issued random password.
- Role-based portal for desktop and mobile browsers.
- Exam definition, scheduling, duration, lifecycle status, and class or student assignment.
- Exam sessions with short-lived codes that expire and can be revoked.
- Server-side validation of every session join, acknowledgement, and link recovery before a Google Forms link is returned. Joining, acknowledging rules, and recovering a link all require online server-side validation.
- Participant tracking and an append-only audit log of administrative and security-relevant actions.
- A static per-room QR code that opens the portal (never an exam or form URL).
- Progressive Web App shell for install and static-asset caching, with honest limits.
- Connection-error handling and safe retry guidance.
- Instrumentation for activity signals such as tab visibility changes, treated as weak signals only.

Out of scope for the MVP, listed with reasons in section 10.

---

## 3. Roles

The system has three roles, each a membership inside a school.

| Role | Summary | Typical device |
| --- | --- | --- |
| School IT administrator (`school_admin`) | Manages accounts, classes, exams, schedules, assignments, sessions, and reports. | Desktop or laptop |
| Invigilator (`invigilator`) | Manages the exam sessions they are assigned to and records incidents. | Tablet, laptop, or phone |
| Student (`student`) | Views assigned exams, joins a session with a code, acknowledges rules, and opens the Google Form. | Personal Android or iPhone |

Accounts are created by an administrator. A person may hold more than one role through separate memberships, but the MVP user interface presents one active role context at a time.

Students sign in with their NISN (national student number) and a school-issued random password. NISN is an identifier, not a secret. Staff sign in with their own administrator-provisioned credentials. The native account identifier that Supabase Auth uses behind the NISN is resolved on the server and is never required from the student.

---

## 4. User journeys

### 4.1 Administrator: prepare an exam

1. Administrator signs in and opens the admin area.
2. Administrator creates or confirms classes and enrolls students (or imports a roster).
3. Administrator creates an exam: title, subject, instructions, duration, and the Google Forms URL.
4. Administrator assigns the exam to one or more classes, or to named students.
5. Administrator schedules one or more sessions for the exam, each with a start time, an end time (the join window), and a duration shown to the student.
6. Administrator publishes the exam. Draft exams are invisible to students.
7. System generates a session code for each session, or the administrator generates them explicitly.
8. Administrator prints or displays the static room QR code, which opens the portal only.

Acceptance ties: FR-EXAM-01, FR-SESS-01, FR-CODE-01, FR-QR-01.

### 4.2 Student: sit an exam

1. Student scans the room QR code (or opens the portal URL) on a personal phone.
2. Student signs in with their NISN and the school-issued random password. NISN is treated as an identifier, not a secret.
3. Student sees the list of exams assigned to them and the status of each.
4. When a session is open, student selects the exam and enters the session code.
5. The portal validates the join server-side (`session-join`, a trusted server function). On success it records the participant as joined and shows the exam rules. The join step never returns the Google Forms link.
6. The student acknowledges the rules. A separate server-validated operation (`session-acknowledge`) records the acknowledgement. Only after successful acknowledgement does the server return the Google Forms link and record the release.
7. Student completes the exam inside Google Forms.
8. If the connection drops, the portal shows a connection-error state with a retry action. The student stays signed in. Retrying does not duplicate the participant, the acknowledgement, or the release.
9. Re-opening a link that was already released uses a separate server-validated recovery operation (`session-recover`). While the session is open, recovery is allowed. After the session ends, recovery is allowed only within the school-configured grace period (FR-REC-01 through FR-REC-03). The portal cannot revoke a Google Forms URL already revealed to a browser.

Acceptance ties: FR-STU-01 through FR-STU-05, FR-ACK-01, FR-REC-01 through FR-REC-03, FR-ERR-01, FR-ERR-02.

Note on credentials: the school issues each student an initial random password out-of-band. How the school distributes that password, and whether the student must change it at first sign-in, are open decisions recorded in section 12.

### 4.3 Invigilator: run a session

1. Invigilator signs in and opens the session assigned to them.
2. Invigilator sees the live participant list with each participant's status (joined, acknowledged, released, completed).
3. Invigilator can revoke a session code, close the session, extend the join window if policy allows, and remove a participant.
4. Invigilator records an incident as an audit event with a short note.
5. Invigilator can mark a participant as completed when the paper is handed in and collected on paper, or leave status as released.

Acceptance ties: FR-INV-01 through FR-INV-04, FR-AUD-01.

### 4.4 Administrator: review after the exam

1. Administrator opens the exam report for a completed session.
2. Report shows participants, timestamps of join, acknowledgement, and release, plus recorded incidents and activity signals.
3. Administrator exports the report as CSV for records retention.
4. Administrator archives the exam. Audit records are retained.

Acceptance ties: FR-REP-01, FR-AUD-02.

---

## 5. Functional requirements

Each requirement has an identifier used across documents and tests. Priority uses MoSCoW.

### 5.1 Authentication and accounts

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AUTH-01 | The portal authenticates staff through Supabase Auth. Students authenticate with NISN and a school-issued random password, resolved through a trusted server function. | Must |
| FR-AUTH-02 | Public self-registration is disabled. Only administrators can create accounts. | Must |
| FR-AUTH-03 | Every authenticated request resolves to exactly one active membership and role for the active school, or access is denied. | Must |
| FR-AUTH-04 | Administrators can create an account, set or reset a password, disable an account, and re-enable it. | Must |
| FR-AUTH-05 | A disabled or uninvited profile cannot access portal data even if an Auth session exists. | Must |
| FR-AUTH-06 | Password policy for newly generated passwords is defined by the school, and the chosen length and character set are recorded before implementation. | Should |
| FR-AUTH-07 | Students sign in with NISN and a school-issued random password. NISN is an identifier, not a secret. | Must |
| FR-AUTH-08 | The native Supabase Auth identifier behind each student account is resolved server-side and is never required from the student. | Must |
| FR-AUTH-09 | Passwords are generated by the school as unique random values per student. The exact length and character set are an open decision; the historical six-letter format is context only and is not mandated. | Must |
| FR-AUTH-10 | The portal never stores a plaintext password. Password verification is performed by Supabase Auth. | Must |
| FR-AUTH-11 | Initial credentials are distributed out-of-band, per student. The distribution method is an open decision. | Must |
| FR-AUTH-12 | Login attempts are rate limited per NISN and per source, and failures return a generic error that does not reveal whether the NISN exists. | Must |
| FR-AUTH-13 | Account and password recovery is administrator-initiated. The recovery method is an open decision. | Must |
| FR-AUTH-14 | Authentication is separate from authorization. A valid session grants no data access until membership, role, assignment, and session policy checks pass. | Must |

### 5.2 Classes, enrollment, and exams

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CLS-01 | Administrators create classes within the school and enroll or unenroll students. | Must |
| FR-EXAM-01 | Administrators create an exam with title, subject, instructions, duration, and a Google Forms URL. | Must |
| FR-EXAM-02 | An exam can be assigned to classes, to individual students, or both. | Must |
| FR-EXAM-03 | An exam has a lifecycle status: draft, published, completed, archived, or cancelled. | Must |
| FR-EXAM-04 | The Google Forms URL of a published exam is never readable by a student through the client API. It is returned only by a server function after eligibility checks. | Must |
| FR-EXAM-05 | Changing the Google Forms URL of an exam is an audited action. | Should |

### 5.3 Sessions, codes, and joins

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-SESS-01 | An exam can have one or more sessions, each with a scheduled start, an end (join-window close), and a per-student duration. | Must |
| FR-SESS-02 | A session has a status: scheduled, open, closed, expired, or cancelled. Open and expired are computed server-side from time and explicit actions. | Must |
| FR-SESS-03 | Each session has a short, human-typable code that is unique while active, expires with the session, and can be revoked. | Must |
| FR-SESS-04 | Session codes are stored hashed with a server-side secret. A database dump does not reveal an active code. | Must |
| FR-CODE-01 | Join attempts are rate limited per student, per session, and per source address. | Must |
| FR-JOIN-01 | A join succeeds only if all eligibility checks pass (authenticated, active membership, assigned, exam published, session open, code valid, not revoked, participant not removed, rate limits clear). | Must |
| FR-JOIN-02 | A successful join creates or updates the participant record to `joined`. The join operation does not return the Google Forms link. | Must |
| FR-JOIN-03 | Join, acknowledgement, and recovery are idempotent. Repeating any of them for the same student and session does not create a duplicate participant row, a duplicate acknowledgement event, or a duplicate logical release event. | Must |
| FR-JOIN-04 | Every join decision, granted or denied, is written to the audit log. | Must |
| FR-ACK-01 | A separate server-validated acknowledgement operation records the student's acknowledgement of the rules. Only after it succeeds may the server return the Google Forms link, and the acknowledgement is recorded once per participant. | Must |
| FR-REC-01 | A separate server-validated recovery operation re-releases a previously released Google Forms link. Before returning the link it revalidates identity, active profile and membership, school, student assignment, participant status (not removed), and the applicable session or grace policy. | Must |
| FR-REC-02 | While the session is open, recovery is allowed. After the session ends, recovery is allowed only before the end of the school-configured grace period, and is denied at and after that boundary. Recovery is rate limited and audited. | Must |
| FR-REC-03 | The portal cannot revoke a Google Forms URL already revealed to a browser. Denying recovery withholds a re-issue; it does not un-reveal a copied URL. | Must |
| FR-SESS-05 | The post-session link-recovery grace period is distinct from the join window and from the exam duration. The join window ends at `join_closes_at`, the exam duration is shown to the student, and the grace period begins only after the session ends. | Must |

### 5.4 Student experience

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-STU-01 | A student sees only exams assigned to them in the active school. | Must |
| FR-STU-02 | A student sees each exam's status and whether a join window is open. | Must |
| FR-STU-03 | A student must acknowledge the exam rules before the form link is released. | Must |
| FR-STU-04 | The form link, once released, is re-issued to that student through the recovery operation while the session is open, and after the session ends only within the school-configured grace period. The duration and the boundary convention must be fixed before implementation; no default is assumed. | Must |
| FR-STU-05 | The portal never stores exam answers or question content. | Must |

### 5.5 Invigilator experience

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-INV-01 | An invigilator sees and manages only the sessions assigned to them. | Must |
| FR-INV-02 | An invigilator can revoke a code and close a session, and this is audited. | Must |
| FR-INV-03 | An invigilator can remove a participant from a session, and this is audited. | Must |
| FR-INV-04 | An invigilator can record a free-text incident as an audit event. | Must |

### 5.6 Reports and audit

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-REP-01 | Administrators and assigned invigilators can view a session report and export it as CSV. | Must |
| FR-AUD-01 | The audit log is append-only for application roles. No role can update or delete audit rows through the client API. | Must |
| FR-AUD-02 | Audit rows record actor, role, school, action, target, timestamp, and a small metadata object. | Must |

### 5.7 Platform behavior

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-QR-01 | A static room QR code resolves to the portal entry URL only. It never contains an exam or Google Forms URL. | Must |
| FR-RESP-01 | The portal is usable on a 360 CSS pixel wide phone and up to desktop width with no horizontal overflow. | Must |
| FR-PWA-01 | The portal is installable and caches its static shell so repeat loads are faster. Caching of exam data and forms is explicitly out of scope. | Should |
| FR-ERR-01 | Any network or server failure during a user action shows a clear error state and a retry action. | Must |
| FR-ERR-02 | Retries are safe: no retry can double-create a participant, double-release a form, or double-charge any counted action. | Must |
| FR-ACT-01 | The portal can record activity signals (tab hidden, tab visible, window blur, focus) as weak signals. | Should |
| FR-ACT-02 | The user interface and reports label activity signals as imperfect indicators, never as proof of misconduct. | Must |

### 5.8 The Google Forms boundary

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-GF-01 | The portal documents that Google Forms does not support offline examination and that a submission is complete only when Google Forms confirms it. | Must |
| FR-GF-02 | The portal documents that once a form URL is revealed to a browser it can be copied, shared, or reopened, and the portal cannot fully retract it. | Must |

---

## 6. Statuses and lifecycles

### 6.1 Exam status

```
draft -> published -> completed -> archived
             |
             +--> cancelled
```

| Status | Meaning | Student visible |
| --- | --- | --- |
| draft | Being prepared. Editable. | No |
| published | Assignments and sessions are live. | Yes |
| completed | All sessions ended; reporting is primary. Editing is locked except notes. | Yes, read-only |
| archived | Retained for records. Not shown in default lists. | No |
| cancelled | Withdrawn before or during delivery. Retained in audit. | No |

### 6.2 Session status

| Status | Meaning |
| --- | --- |
| scheduled | Exists, start time is in the future. |
| open | Current server time is within the join window and the session is not closed. |
| closed | An invigilator or administrator closed it early. |
| expired | The join window elapsed without a manual close. |
| cancelled | Session withdrawn. |

`open` and `expired` are derived on the server from the join window and explicit actions. The client never decides whether a session is open; it displays the server's answer.

### 6.3 Participant status

| Status | Meaning |
| --- | --- |
| invited | Assigned, has not joined. |
| joined | Passed the join check, has not acknowledged rules. |
| acknowledged | Accepted the rules, form not yet released. |
| released | Form link returned, exam may be in progress. |
| completed | Marked done. This is a manual or self-reported state, not a verified Google Forms submission. |
| expired | Session ended before completion. |
| removed | Removed by an invigilator or administrator. |

The portal does not claim to know whether a Google Form was submitted. `completed` is a bookkeeping state and is labeled as such in reports.

### 6.4 Link recovery grace period

The grace period is a distinct concept from the join window and the exam duration. It governs only whether a link that was already released to a student may be re-issued after the session ends.

- The join window is the interval during which a student may join a session. It ends at `join_closes_at`.
- The exam duration is informational and shown to the student. It does not gate server operations by itself.
- The grace period begins only after the session ends. Recovery requests are allowed while the session is open and, after it ends, only before the end of the grace period.
- Boundary convention: the grace period ends at the instant computed from the session end plus the configured duration. Recovery is allowed strictly before that instant and denied at and after it.
- The reference point for "session end" (the scheduled end versus the actual manual close time) and the duration itself are school decisions recorded in section 12.
- The portal cannot revoke a URL already revealed to a browser. Recovery only controls whether the server re-issues the link.

---

## 7. Acceptance criteria

These are testable. Each maps to a verification method in `IMPLEMENTATION_PLAN.md`.

1. Authentication and authorization
   - A student signs in with NISN and the correct password and receives a session.
   - A student sign-in with a wrong password, or with NISN alone, is denied.
   - A disabled account cannot sign in and cannot access data even with a session.
   - Repeated failed sign-ins for one NISN are rate limited and return generic errors.
   - No table readable by a student reveals the native Supabase Auth identifier mapping or a plaintext password.
   - A student token cannot read another school's rows, another class's exams, or any other student's participant rows. Verified by RLS tests.
   - A student token cannot read the Google Forms URL from any table directly. Verified by attempted query returning zero rows.
   - A disabled profile cannot read portal data even with a valid Auth session.

2. Session join and acknowledgement
   - Join with a correct code, inside the window, for an assigned student and published exam succeeds and creates or updates the participant as joined. It does not return a form link.
   - Join fails, with a distinct documented reason, for each of: wrong code, expired code, revoked code, closed session, expired window, unassigned student, unpublished exam, removed participant, and rate-limit exceeded.
   - Repeating a successful join does not duplicate the participant row.
   - Acknowledgement is a separate server-validated operation, and the form link is returned only after it succeeds.
   - Repeating an acknowledgement does not create a duplicate acknowledgement or a duplicate release event.
   - Each attempt, allowed or denied, produces exactly one audit row.

3. Codes
   - A code stored in the database is not present in plaintext in the table that holds it.
   - Revoking a code makes further joins fail immediately.
   - Expiring the join window makes further joins fail without a manual action.

4. Student experience
   - A student only ever sees their own assigned exams.
   - The form link is not present in any join response, and not present in any client response before a successful acknowledgement.
   - The form link, once released, is available again without re-entering the code while the session is open.
   - No join or acknowledgement retry returns the form link after the grace-period boundary.

5. Invigilator
   - An invigilator cannot see sessions they are not assigned to.
   - Revoke, close, remove, and incident actions each produce an audit row and take effect.

6. QR and portal
   - The QR payload, when decoded, equals the portal entry URL and contains no exam or form identifier.
   - The layout has no horizontal overflow at 360 pixel width.

7. Offline and errors
   - With the network disabled, a join action shows a connection-error state and a retry action, and does not report false success.
   - Re-enabling the network and retrying produces at most one release event.

8. Link recovery
   - A previously released link can be re-obtained through the recovery operation while the session is open.
   - After the session ends, recovery succeeds before the end of the configured grace period.
   - Recovery exactly at the configured boundary is denied; the grace period ends at that instant.
   - Recovery after the boundary is denied.
   - Recovery revalidates identity, active profile and membership, school, assignment, and participant status; a removed or disabled participant is denied.
   - Recovery does not duplicate participants, acknowledgements, or logical release events.
   - The portal does not claim it can revoke a URL already revealed to a browser; denial of recovery does not un-reveal a copied URL.

9. Reliability
   - The load-test plan in `RELIABILITY_AND_SCALE.md` runs to completion and reports results. Targets are treated as unverified until that run passes.

---

## 8. Non-functional requirements

| ID | Requirement | Notes |
| --- | --- | --- |
| NFR-01 | Client is React, Vite, and JSX. | No server-rendered app framework. |
| NFR-02 | Backend is Supabase Auth and PostgreSQL, with server functions for trusted operations. | |
| NFR-03 | No service-role or secret key is ever shipped to the browser. | Enforced by build and review. |
| NFR-04 | Row Level Security is enabled on every client-accessible table. | |
| NFR-05 | Schema is tenant-aware from migration one (a `school_id` on every tenant-owned row). | |
| NFR-06 | Primary keys are UUIDs. | |
| NFR-07 | Exam timing and session validity are server-authoritative. | |
| NFR-08 | Write operations that can be retried are idempotent. | |
| NFR-09 | The design targets 1,500 concurrent students as a load-test plan, not a proven capacity. | See `RELIABILITY_AND_SCALE.md`. |
| NFR-10 | The deployment is usable on slow or intermittent mobile connections. | |
| NFR-11 | Operating cost stays within free or low-cost tiers where possible, with limits documented. | |

---

## 9. Assumptions and constraints

- Students bring personal Android and iOS phones on shared or personal mobile networks.
- Each student has an NISN known to the school. Students are not assumed to have a personal email address or phone number for login.
- The school can distribute initial passwords to students out-of-band and can host or print a static room QR code.
- The historical student password format (six random letters, for example `SZBFAB`) is context only and does not constrain this project.
- Google account access needed to create and manage the Google Forms is available to the school.
- Session codes are typed by hand, so they are short and use an unambiguous alphabet.
- The browser is not a trusted execution environment and cannot enforce device lockdown.
- Administrators accept that activity signals are weak and cannot prove cheating.

---

## 10. Non-goals

- No question authoring or answer storage in this portal. Google Forms owns questions and responses.
- No attempt to make Google Forms work offline. It does not.
- No claim that a browser can lock down a phone, block a second device, or prevent screenshots.
- No public self-registration.
- No claim that NISN is a secret, and no use of NISN as a password.
- No synthetic or fabricated email addresses created to stand in for student identities.
- No payment processing.
- No native mobile applications in the MVP (PWA only).
- No automated grading or result publishing.
- No biometric or ID verification.
- No real-time video proctoring.
- No SMS delivery of codes in the MVP (codes are shown in the portal and on the room display).
- No cross-school analytics in the MVP, though the schema allows it later.

---

## 11. Risks and mitigations at product level

| Risk | Mitigation | Residual |
| --- | --- | --- |
| A revealed form URL is shared with non-eligible people. | Return it only after eligibility checks and acknowledgement; short join windows. | Cannot fully retract. Documented. |
| A retry or recovery request obtains the form URL after the allowed window. | Join, acknowledgement, and recovery always revalidate the session and grace policy server-side; no cached URL is ever served. | A URL already copied cannot be recalled. |
| Weak network causes duplicate joins on retry. | Idempotent join keyed on student and session. | Low. |
| Activity signals misinterpreted as proof. | Label as weak in UI and reports; require human judgement. | Depends on invigilator training. |
| Free-tier limits exceeded at peak. | Load-test plan, egress budget, caching of static assets only. | To measure. |
| Multi-tenant leakage after a later school is added. | `school_id` from migration one; RLS tests per role. | Requires test discipline. |
| NISN-based login uses a school-issued password that can be shared or reused. | Unique random password per student; login rate limiting; consider a forced first-login change (open decision). | Depends on the approved password policy and student behaviour. |
| Initial passwords intercepted during out-of-band distribution. | Per-student sealed or in-person distribution; consider a forced first-login change. | Depends on the distribution method (open). |
| The native Supabase Auth identifier for student accounts is unresolved. | Recorded as a blocking decision (section 12 and `IMPLEMENTATION_PLAN.md`). | Blocks student provisioning until decided. |

---

## 12. Open questions

These are unresolved and must be answered before or during the relevant milestone. They are grouped by the milestone they block. `IMPLEMENTATION_PLAN.md` section 5 repeats the same grouping by gate.

Confirmed decisions (recorded here so they are not reopened):

- The student login experience is NISN plus a school-issued random password. NISN is an identifier, not a secret. Public self-registration is disabled.
- The Google Forms link is returned directly by the server after authorization and a successful acknowledgement. The optional logging redirect endpoint is deferred and is not part of the MVP.
- The portal cannot revoke a Google Forms URL already revealed to a browser.

Required before M1 (project skeleton):

1. Which Supabase region is closest to the school, and will a single region meet latency targets?
2. The frontend host and its free-tier limits (also in `ARCHITECTURE.md`).

Required before M3 (authentication):

3. The native Supabase Auth identifier for student accounts (school-issued email, phone, or another approved scheme), given that fabricated email addresses are not permitted. This is the only unresolved part of the student login method; the login experience itself is decided.
4. Password length and character set, and whether a forced change at first sign-in is required. The historical six-letter format is context only.
5. How initial passwords are distributed out-of-band, and how account and password recovery is handled and verified.
6. Login rate-limit values and lockout duration.

Required before M5 (form release and link recovery):

7. The school-approved duration of the post-session link-recovery grace period. No default is assumed.
8. Who is authorized to configure the grace-period duration.
9. Whether a manual session close changes the grace-period calculation (that is, whether the grace period is measured from the scheduled session end or from the actual close time).
10. Whether the recovery operation is also exposed while a session is still open, or only after it ends.

Other:

11. The required audit retention period, and whether it conflicts with free-tier storage limits.
12. Is the school able to manage Google Forms access (for example, restricting the form to signed-in accounts within the school domain)?
13. The room and seating model: one static QR per room, or per room and per session.
14. The acceptable offline behavior for the invigilator console on a flaky network.
15. Whether per-student duration enforcement is required, and who enforces it.
16. The approved device policy for the future Android kiosk path.
17. The minimum supported browser and OS version for the student PWA.
18. Who owns the free-tier billing account and the approved spending ceiling if limits are exceeded.
