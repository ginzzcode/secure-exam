# THREAT_MODEL.md

Secure Exam Portal, threat model.

Status: draft specification. No application code exists yet.

Method: STRIDE, applied to the trust zones and assets below. Findings are pairs of threat and mitigation, with residual risk stated. This document also states the BYOD device limitations plainly, because those limits are part of the honest threat picture.

Companion documents: `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `RELIABILITY_AND_SCALE.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Scope and method

In scope: the portal (React SPA, Supabase Auth, Postgres, Edge Functions), the session code mechanism, the Google Forms handoff, and the BYOD devices students use.

Out of scope of this document: Google's own infrastructure and Google Forms security, the school's network hardware, the school's physical invigilation practice, and the school's identity decisions.

Assumption: the browser and the student's phone are untrusted. A motivated student controls their device.

---

## 2. Assets

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Google Forms URL | Direct access to the exam paper | `exam_form_links`, service-role only |
| Link-recovery grace policy | Controls whether a released link is re-issued after a session ends | `exam_sessions.link_recovery_grace_minutes`, enforced service-side |
| Session codes | Short-lived keys to open a session | hashed and encrypted in `session_codes`, secrets in Edge Functions |
| User accounts and credentials, including NISN login aliases and school-issued passwords | Impersonation, unauthorized access | NISN aliases in `login_identifiers`; passwords hashed in Supabase Auth |
| Student PII (name, email, NISN, enrollment) | Privacy, safeguarding | `profiles`, `login_identifiers`, `memberships`, `class_enrollments` |
| Exam schedule and assignments | Integrity of exam delivery | `exams`, `exam_assignments`, `exam_sessions` |
| Participant records | Evidence of who was eligible and when | `session_participants` |
| Audit log | Accountability and incident review | `audit_events` (append-only) |
| Service-role key and secrets (pepper, encryption key) | Full data control if leaked | Edge Function secrets only |
| Availability of the join path | Students must reach the exam | Edge Function and Postgres |

---

## 3. Trust boundaries

1. Browser to CDN: untrusted input, static output only.
2. Browser to Supabase API: untrusted client, JWT-authenticated. RLS and function checks enforce authority.
3. Edge Function to Postgres (service role): inside the trusted zone.
4. Portal to Google Forms: a boundary the portal does not control. Once crossed, the portal has no visibility.

---

## 4. Threats and mitigations (STRIDE)

### 4.1 Spoofing

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| S1 | Attacker signs in as a student with stolen credentials. | Supabase Auth, password policy, optional rate limiting on sign-in. | Credential sharing remains possible; out of scope for MVP. |
| S2 | Forged JWT with a modified role or school claim. | Roles and school come from database tables, never from token claims. Functions resolve membership server-side. | None expected if implemented as specified. |
| S3 | A student presents another student's session code. | The code is only one factor. Eligibility also requires the caller's own membership and assignment. A code alone does nothing for an unassigned user. | A code shared with an eligible classmate still works for that classmate. Mitigated by short windows and audit. |
| S4 | Password brute force against a student NISN. | Login is rate limited per NISN and per source with a short lockout; failures return generic errors. | A slow, distributed attempt is bounded by rate limits and monitoring. |
| S5 | NISN enumeration to discover valid accounts. | NISN is an identifier and may be semi-public, but failures are generic and identical whether the NISN exists or not; the alias table is service-role only. | NISN values may be known within a school; this is accepted. |
| S6 | Shared or reused student passwords. | A unique random password per student; consider a forced first-login change (open decision). | Depends on the approved password policy and student behaviour. |
| S7 | Initial passwords intercepted during out-of-band distribution. | Per-student distribution; consider a forced first-login change. | Distribution method is an open decision. |
| S8 | Recovery flow abused to take over an account. | Recovery is administrator-initiated and verified; the method is an open decision and must be defined before implementation. | Risk depends on the recovery design. |

### 4.2 Tampering

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | Client edits request body to add `school_id` or `role`. | Server derives both from the token and database; body values ignored. | None expected. |
| T2 | Client edits session timing locally to force `open`. | Timing is server-authoritative via `session_effective_status`. | None expected. |
| T3 | Client calls the database directly to insert a participant or release a form. | Participant writes and releases go through `session-join`; RLS blocks arbitrary inserts; form URL is unreadable by clients. | None expected if policies hold. |
| T4 | Attacker modifies audit rows to hide activity. | Append-only: no update or delete policy, plus a trigger that raises. | None expected. |
| T5 | Replay of a join request to create duplicates or re-release the form. | Idempotent join keyed on (session_id, student_id); acknowledgement and release are idempotent per participant via `session_link_events`. | Low. |
| T6 | A client retries join, acknowledge, or recovery to obtain the URL after the allowed window. | Every release and recovery revalidates the session and grace policy server-side; no cached URL is ever served. | A URL already copied cannot be recalled. |

### 4.3 Repudiation

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| R1 | A student denies they acknowledged the rules. | Acknowledgement stored with server timestamp and audit row. | Weak if the account was shared. |
| R2 | An invigilator denies revoking a code or removing a participant. | Every control action writes an audit row with actor and time. | Low. |
| R3 | An administrator denies changing the form URL. | Form URL changes are audited. | Low. |

### 4.4 Information disclosure

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| I1 | Google Forms URL leaked to an ineligible person. | URL in a table with no client policy; returned only by `session-acknowledge` (first release) or `session-recover` (within the session or grace policy) after checks. The logging redirect is deferred. | Once revealed, cannot be fully retracted. Documented. |
| I2 | Session code recovered from a database dump. | Codes stored as HMAC hash for lookup and AES-GCM ciphertext for display; keys are Edge Function secrets. | Requires both database and secret compromise. Low. |
| I3 | Cross-tenant data leak. | `school_id` on every tenant row; RLS filters by `current_school_id()`; per-table isolation tests. | None expected. |
| I4 | A student reads another student's data. | RLS restricts student reads to own rows. | None expected. |
| I5 | PII exposed in logs or error messages. | Error responses are generic; logs avoid PII and secrets; metadata in audit excludes codes and URLs. | Low. |
| I6 | Enumeration of valid session codes through timing or error differences. | Uniform error responses for bad code versus expired code in the client; server logs detail but the client sees a generic denial. | Low. |
| I7 | Disclosure of the NISN to native Auth identifier mapping. | The mapping lives in `login_identifiers`, which has no client policy; `auth-login` returns only session tokens and minimal profile data. | Requires service-role compromise. |
| I8 | A plaintext password or the native identifier leaks in logs or errors. | Passwords are never stored or logged by the portal; `auth-login` and Supabase Auth handle secrets server-side; errors are generic. | Low. |
| I9 | A recovery request reveals whether a given participant was released. | Recovery requires an authenticated, owned student membership; denials are generic; attempts are audited. | Low. |

### 4.5 Denial of service

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| D1 | Brute-force guessing of short session codes. | Short active windows, rate limiting per student, per session, and per source, code expiry, and revocation. | A code is short; entropy is limited by human typing. Window length is the main control. |
| D2 | Flooding `session-join` from one source. | Per-source rate limiting; Supabase and CDN platform limits; fail-closed denies. | A distributed flood is a platform-level concern. |
| D3 | Mass account creation. | No public sign-up; accounts are provisioned by admins only. | None expected. |
| D4 | A single session code used by many people at once. | Optional max_uses, participant cap per session, and audit of release counts. | Legitimate sharing within a class is expected; abuse is bounded by audit. |

### 4.6 Elevation of privilege

| ID | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| E1 | A student calls `session-control` or `admin-provision`. | Functions verify role and assignment server-side and deny with audit. | None expected. |
| E2 | An invigilator acts on an unassigned session. | Function checks `is_session_invigilator`; RLS blocks direct reads. | None expected. |
| E3 | A disabled profile keeps access via an old session. | Predicates require a profile active status; disabled or suspended yields no access even with a valid token. | Token expiry plus predicate checks. Low. |
| E4 | Service-role key reaches the browser. | Key exists only in Edge Function secrets; build and review checks; browser holds only the anon key. | None expected if enforced. |

---

## 5. Exam-integrity threats specific to BYOD

These are the threats a web app cannot fully solve. They are stated so no one assumes the portal provides lockdown.

| ID | Threat | Reality | Partial mitigation | Residual |
| --- | --- | --- | --- | --- |
| B1 | Student opens a second device (laptop, second phone) to look up answers. | A browser cannot detect a second device. | Physical invigilation; room policy; optional device collection. | Not solvable by the portal. |
| B2 | Student takes screenshots of the paper. | A browser cannot generally prevent screenshots on a personal phone. | None reliable; Google Forms and OS controls vary. | Not solvable by the portal. |
| B3 | Student switches tabs or apps to search. | The portal can receive visibility events, but they are unreliable (notifications, calls, and OS behavior trigger them too). | Record activity signals as weak indicators for human review. | Signals are noisy; they must not be treated as proof. |
| B4 | Student shares the form URL with a classmate. | Once revealed, the URL can be shared. | Short windows; per-student audit; optional Google Forms restriction to the school account domain; logging redirect. | Cannot fully prevent sharing. |
| B5 | Student uses accessibility or automation tools to auto-fill or read answers. | A browser cannot distinguish all assistive technology from automation. | Treat as policy matter; audit anomalies for review. | Accessibility needs must not be broken in the name of anti-cheat. |
| B6 | Student roots or jailbreaks the phone to bypass app-level controls. | The portal is a web page, not a managed app. There are no app-level controls to bypass. | Managed devices (see section 6) are the only robust path. | Not solvable with BYOD. |

The portal must present activity signals as imperfect indicators. See `PROJECT_SPEC.md` FR-ACT-02 and `RELIABILITY_AND_SCALE.md` for how they are surfaced.

---

## 6. Android and iOS BYOD limitations

Stated plainly, because the requirements forbid claiming full device lockdown.

### 6.1 What the portal cannot do on any phone

- It cannot lock the device to one app or one web page.
- It cannot block a second device.
- It cannot prevent screenshots on a personal phone in the general case.
- It cannot detect all app switching reliably.
- It cannot guarantee the student stays on the Google Form.
- It cannot make Google Forms work offline.

### 6.2 Android

- Android Enterprise kiosk mode (dedicated devices, lock task mode) can restrict a managed device to one app. This requires Managed Google Play and enrollment, typically on school-owned or fully managed devices.
- Android kiosk is not available to a plain web page on a personal, unmanaged phone.
- Path: evaluate managed Android devices as a future option, not an MVP feature. This is a stated future evaluation, not a promise.

### 6.3 iOS

- Guided Access can lock an unmanaged iPhone or iPad to one app, but a teacher or the student must start it manually, and it locks to an app, not reliably to one web page within a browser flow.
- Supervised mode with an MDM can apply stronger restrictions, but supervision requires a factory wipe and enrollment, which is impractical for personal devices in the MVP.
- Path: document realistic limits; do not promise iPhone lockdown. This is a future evaluation only.

### 6.4 Honest conclusion

On personal BYOD phones, the portal controls access to the form, not the device. Exam integrity on BYOD depends on physical invigilation and school policy. The portal improves access control and auditability; it does not deliver lockdown.

---

## 7. Google Forms specific risks

| Risk | Detail | Mitigation | Residual |
| --- | --- | --- | --- |
| No offline support | Google Forms requires connectivity to load and submit. | Portal documents this. No offline promise is made. | Student on a dead network cannot submit. |
| No portal-verified submission | The portal cannot confirm a submission happened. | Participant status `completed` is labeled as bookkeeping, not verification. | Schools rely on Google Forms responses. |
| Access control is Google's | The form's own access settings decide who can open it. | Recommend restricting the form to the school account domain; document as an open question. | Depends on the school's Google configuration. |
| URL persistence | A form URL remains valid beyond the session unless the owner closes the form. | Optional: close the form after the session; portal cannot force this. | Depends on manual action. |

---

## 8. Detection, monitoring, and response

- Security-relevant denials are logged in `audit_events` with reasons.
- Rate-limit and sign-in triggers are logged in `join_attempts` and `login_attempts`.
- Anomalies worth review: many join denials for one student, many failed sign-ins for one NISN or one source, recovery attempts at or after the grace boundary, one code used by an unexpected number of participants, a code used outside the school network if that signal is available, and bursts of activity signals.
- Response playbook: revoke the code, close the session, remove the participant, note the incident, and preserve audit rows.
- Alert threshold and channel are an open question.

---

## 9. Residual risk register

| Risk | Severity | Accepted because |
| --- | --- | --- |
| Form URL shared after release | Medium | Cannot be fully retracted; mitigated by short windows and audit. |
| Second device use | High for integrity | Not solvable by a web app; belongs to physical policy. |
| Screenshots | Medium | Not preventable on personal phones. |
| Activity signals misread as proof | Medium | Mitigated by explicit labeling and human review. |
| Short code brute force | Low to Medium | Mitigated by window length, rate limits, and revocation. |
| Free-tier limits at peak | Medium | Addressed by load testing plan. |
| PII retention on free tier | Low to Medium | Addressed by retention policy. |
| Student password sharing or reuse | Medium | Bounded by unique random passwords, rate limits, and audit; a forced first-login change is an open decision. |
| Initial password intercepted in distribution | Medium | Per-student distribution; the exact method is an open decision. |
| Native Auth identifier mapping undisclosed but service-role only | Low | Requires service-role compromise to read. |
| Recovery attempt after the grace boundary | Low | Denied server-side and audited; a copied URL cannot be recalled. |

---

## 10. Security acceptance tests

1. Attempt to read the form URL as a student; zero rows returned.
2. Attempt to read `session_codes` as any client role; zero rows returned.
3. Verify the browser bundle contains no service-role key or secret (build scan).
4. Verify a database dump does not contain a plaintext active session code.
5. Verify saving a new form URL writes an audit row.
6. Verify updating or deleting an `audit_events` row is rejected.
7. Verify a disabled profile cannot read tenant data with a valid token.
8. Verify cross-tenant reads return zero rows for every table.
9. Verify `session-control` and `admin-provision` deny a student with an audit row.
10. Confirm the UI labels activity signals as imperfect indicators (manual review).
11. Sign in with NISN and a wrong password; denied with a generic error and a `login_attempts` row.
12. Sign in as a disabled account; denied even with the correct password.
13. Verify repeated failed sign-ins for one NISN trigger rate limiting or a lockout.
14. Attempt to read `login_identifiers` as any client role; zero rows returned.
15. Confirm the `auth-login` response contains no native identifier and no plaintext password.
16. Confirm the `session-join` response contains no form link.
17. Confirm recovery returns the link before the grace boundary and is denied exactly at and after the boundary.
18. Confirm no retry of join, acknowledge, or recovery can obtain the link after the grace boundary.

---

## 11. Open questions

1. Does the school restrict Google Forms to the school account domain? This changes residuals for B4 and I1.
2. What is the school's physical invigilation and device policy? This sets the real bound on B1 and B2.
3. Alerting channel and thresholds for security denials.
4. Whether any signal (for example, a code used by many participants) should auto-close a session, or only alert.
5. Data protection rules the school must satisfy for student PII, and whether a data processing agreement is needed.
6. The native Supabase Auth identifier for student accounts (school-issued email, phone, or another approved scheme), since fabricated email addresses are not permitted.
7. Password length and character set, and whether a forced change at first sign-in is required.
8. How initial credentials are distributed and how recovery is handled and verified.
9. Login rate-limit values and lockout duration.
10. Who is authorized to configure the link-recovery grace-period duration, and whether a manual session close changes the calculation.
