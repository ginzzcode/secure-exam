# RELIABILITY_AND_SCALE.md

Secure Exam Portal, reliability, poor-network behavior, and load-testing plan.

Status: draft specification. No test has been run. Every target and number in this document is a plan or an assumption, not a measured result. Nothing here means Supabase, the chosen CDN host, or Google Forms has been shown to meet the target.

Companion documents: `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `ACCESS_CONTROL.md`, `THREAT_MODEL.md`, `IMPLEMENTATION_PLAN.md`.

---

## 1. Scale statement

The design target is more than 1,000 concurrent students, planned and tested at 1,500 virtual users, because students often join in a burst at the start of a sitting.

This is a target, not a claim. The portal must not be described as able to serve 1,500 students until the load test below runs against staging and passes the stated criteria.

Key observation: the load is bursty, not steady. The hard moment is the first minutes of a session, when many students join at once. Steady-state reading is light by comparison.

---

## 2. Poor-network behavior

Assumptions: shared school Wi-Fi or mobile data, high packet loss possible, latency spikes, intermittent outages, and phones that switch between Wi-Fi and cellular.

### 2.1 Principles

1. Fail closed on the server. If the server cannot confirm eligibility, it denies. It never returns a form URL from a degraded path.
2. Fail clear on the client. The user always sees whether an action succeeded, failed, or is unknown.
3. Retry safely. Every retryable action is idempotent.
4. Do not pretend to work offline. The shell may load offline; the exam cannot.
5. Recovery is not a bypass. Re-issuing a released link is allowed only within the session or the configured grace period, checked on the server on every call.

### 2.2 Client behavior on weak networks

| Situation | Behavior |
| --- | --- |
| Slow response | Show a progress state with an indication it may take a moment. Do not spin forever; apply a client timeout. |
| Request times out | Show an error state with a Retry action. State that the outcome is unconfirmed. |
| Retry | Re-send with the same idempotency key so the server returns the same result. |
| Connection lost before send | Show "not sent" clearly, not "failed", and offer Retry. |
| Connection lost after send | Show "unconfirmed" and offer Retry. The idempotent server resolves it. |
| Offline shell | Serve the cached app shell, then show a connection-error state for any data need. |
| Reconnect | Offer a manual Retry; do not auto-hammer the server. |

### 2.3 Timeouts and backoff

- Client request timeout for reads and joins: a planned short timeout (for example 15 seconds) so the student is not left waiting.
- Retry backoff: exponential with jitter, capped. A planned sequence is 1s, 2s, 4s, 8s, capped at 30s, with a maximum of a few attempts, after which the user retries manually.
- No infinite automatic retry. This protects the server during a mass outage.

---

## 3. Caching

Honest limits. Caching is not a substitute for the server check.

| Layer | Cached | Not cached | Reason |
| --- | --- | --- | --- |
| CDN | Static build assets, hashed and immutable | Anything authenticated | Static assets are safe and reduce egress. |
| Service worker (PWA) | App shell, static assets, offline fallback page | Authenticated data, form URLs, session state | Caching protected content on a shared phone is a risk and misleads the user. |
| Client memory | Short-lived query results (exams list, session status) | Form URLs beyond the current session, secrets | Improves repeat navigation. |
| Server | Nothing eligibility-critical | | Eligibility and timing are computed per request. |

Rules:

- Never serve a cached "session is open" answer. Recompute on the server.
- Never cache a form URL in the service worker.
- Never cache passwords, NISN-to-identifier mappings, or session tokens.
- A stale data view must be visibly marked stale, with a Retry action.

---

## 4. Idempotency

The join path is the critical one for retries on mobile networks.

| Operation | Idempotency key | Effect of a duplicate |
| --- | --- | --- |
| `session-join` | (session_id, student_id), plus an optional client idempotency token | Returns the same participant state (joined); does not create a second participant and never returns the form link. |
| `session-acknowledge` | (participant_id, event_type, idempotency_key) | Sets `acknowledged_at` and `released_at` once; a duplicate does not create a second release event. Returns the link only if the session or grace policy still allows. |
| `session-recover` | (participant_id, event_type, idempotency_key) | A repeat of the same request does not create a second recovery event. Subject to the session or grace policy on every call. |
| `session-control` actions | Action id or target state | Revoke and close are idempotent. Remove is idempotent. |
| activity events | (participant_id, client_seq) | Duplicate seq is ignored. |
| audit inserts | Trusted-function call | A retried call may log again; audit is allowed to show attempts. This is acceptable and preferred over dropping a record. |

How the join and release resolve a retry:

1. Upsert on the unique (session_id, student_id). Postgres `insert ... on conflict ... do update` makes this a single atomic statement.
2. A retry of join returns the participant state only. It never returns the form link.
3. A retry of acknowledge or recover that would re-issue the link is treated as a fresh recovery and must pass the session or grace policy. A generic retry cannot bypass recovery policy after the grace boundary.
4. The idempotency key is recorded in `session_link_events` so a retried request is recognized and does not create a duplicate logical release event.

---

## 5. Rate limiting and quotas

Rate limits protect short codes and the join path. Values below are starting plans and must be tuned from load-test data.

| Scope | Planned limit | Purpose |
| --- | --- | --- |
| Join attempts per student per session | A small number per minute, with a short lockout | Slow brute force and accidental loops |
| Join attempts per session | A cap per minute across all students | Protect the function from a storm |
| Join attempts per source address | A cap per minute | Slow a single-source flood |
| Code lifetime | Bound to the join window, plus optional shorter expiry | Reduce the guessable window |
| Participant cap per session | Configured per session | Bound use of a shared code |
| Login attempts per NISN | A small number per minute, with a short lockout | Slow password brute force against one student |
| Login attempts per source address | A cap per minute | Slow a single-source flood |
| Sign-in attempts (staff) | Platform or function limit | Slow credential attacks |
| Link recovery attempts per student per session | A small number per minute | Slow repeated recovery and link scraping |

The portal records attempts and denials in `join_attempts`, `login_attempts`, `session_link_events`, and `audit_events`, and returns a generic denial to the client.

---

## 6. Load-testing plan

Tooling: k6 (or an equivalent scriptable load tool). Tests run against a staging Supabase project that mirrors production settings and data volume, never against production.

### 6.1 Objective

Determine the achievable concurrency and the bottleneck before promising 1,500 concurrent students. Produce evidence, not a claim.

### 6.2 Test environment assumptions

- A staging Supabase project on the chosen plan, in the school's region.
- Data volume representative of one school at exam time: a planned set of seeded classes, students, assignments, sessions, and participants (for example an order of magnitude around the concurrency target, to be finalized before the test).
- Frontend served from the production-like CDN.
- Load generators on a network path separate from the target, sized so the generators are not the bottleneck.
- Google Forms excluded from the load test, because the portal does not control it. The test stops at the form-link handoff. A separate, small manual test confirms the handoff opens Google Forms.

### 6.3 Scenarios

| Scenario | Description | Approx weight |
| --- | --- | --- |
| Cold sign-in | Virtual users sign in from unauthenticated state at the start, including the student `auth-login` path | One burst at test start |
| Join burst | Mass simultaneous `session-join` calls when a session opens | The critical scenario |
| Dashboard reads | Exams list, session status, participant status reads | Sustained background |
| Invigilator polling | A few invigilators polling session participants | Small, steady |
| Activity burst | Batches of activity events from many students at once | Short bursts |
| Mixed steady state | A blend of the above over several minutes | Sustained |

### 6.4 Virtual-user profile (1,500)

- 1,500 virtual students.
- Ramp up in a short window to simulate the start-of-session rush, then hold.
- Peak scenario: all 1,500 attempt to join within a short window, for example one to two minutes.
- Invigilators: a small number, for example a few per test, polling.
- Duration: long enough to cover ramp, peak, and a steady tail.

The exact ramp shape is an open question and must be agreed before the test.

### 6.5 Performance targets (plans, unverified)

These are targets to test against. They are not results. All are p95 unless stated.

| Operation | Target | Notes |
| --- | --- | --- |
| `session-join` under peak burst | p95 under 800 ms, error rate under 1% | The critical path |
| Sign-in (staff direct, student through `auth-login`) | p95 under 1.5 s | Bursty at start; the student path adds one function hop and one database lookup |
| Exams list read | p95 under 1.0 s | Sustained |
| Participant status read (student) | p95 under 1.0 s | Sustained |
| Invigilator participant list | p95 under 1.5 s | Small audience |
| Activity event write | p95 under 1.0 s | Bursty, best effort |

Error rate is measured over successful eligibility checks. A legitimate denial (for example wrong code) is not an error.

### 6.6 Failure criteria

The test fails, and 1,500 must not be claimed, if any of these hold:

- `session-join` error rate exceeds 1% under the peak burst.
- `session-join` p95 exceeds the target by a wide margin (for example twice the target).
- The database connection pool is exhausted or the function timeouts appear.
- Duplicate participants or duplicate releases occur under retry.
- Cross-tenant or cross-student leakage appears in any response.
- Rate limiting blocks legitimate joins during the legitimate ramp.

### 6.7 What the test must record

- Per-endpoint latency percentiles (p50, p95, p99) and error rate.
- Database connection utilization, slow queries, and locks.
- Edge Function cold starts and duration.
- Rate-limit trigger counts.
- Resource limits hit (storage, egress, function invocations).

### 6.8 Reporting rule

The result is a measured pass or fail against section 6.5, with the environment described. Until then, all capacity statements are plans.

---

## 7. Monitoring and observability

| Signal | Source | Alarm idea |
| --- | --- | --- |
| Function error rate and latency | Edge Function logs and metrics | Error above threshold, or latency above target |
| Join denials by reason | `audit_events` and `join_attempts` | Spike in denials of a given reason |
| Rate-limit triggers | `join_attempts`, `login_attempts` | Sustained triggers during a legitimate ramp |
| Login failures and lockouts | `login_attempts` and `audit_events` | Spike in failed student sign-ins or lockouts |
| Database load | Supabase metrics | Connection saturation, slow queries |
| Egress and storage | Provider dashboards | Approaching free-tier limits |
| Auth failures | Supabase Auth logs | Sign-in failure spike |
| Client errors | Client error reporting (optional) | Error surge from student devices |

Monitoring depth on free tiers is limited. The plan is to use what the provider exposes, plus the portal's own audit tables, and to add client error reporting if budget allows.

---

## 8. Cost assumptions

Costs depend on the chosen providers and plans. The figures below are order-of-magnitude free-tier expectations to verify against the current published pricing at implementation time. They are not quotes and not guarantees. The school's own account and region decide the real numbers.

| Component | Free or low-cost expectation | Risk at 1,500 concurrent |
| --- | --- | --- |
| Supabase project | Free tier has limits on database size, monthly active users, and egress | Egress and concurrent connections are the likely first limits |
| Edge Function invocations | Free tier includes a monthly invocation allowance | A join burst uses many invocations in a short time |
| CDN host (Vercel, Netlify, Cloudflare Pages, or similar) | Free tier includes a monthly bandwidth allowance | Static assets are small; PWA installs increase repeat loads |
| Google Forms | Free with a Google account | Not a portal cost |
| Domain | Small annual cost if a custom domain is used | Stable QR code |

Cost-reduction levers:

- Cache static assets aggressively at the CDN to cut egress.
- Keep the PWA shell small.
- Rate-limit the join path so a storm does not multiply invocations.
- Avoid storing activity events longer than needed, to cut storage and egress.
- Poll infrequently for the invigilator console, or use Realtime with a small subscriber count.

Honest note: free tiers are not sized for a 1,500-student burst by default. The load test will show whether the free tier holds or a paid tier is required. Budget an upgrade path.

---

## 9. Reliability acceptance tests

1. Run the load test at 1,500 virtual users and record results against section 6.5.
2. Disable the network mid-join and confirm the client shows an unconfirmed or error state and that a retry produces at most one release.
3. Simulate duplicate delivery of the same join request and confirm one participant row.
4. Simulate a slow database and confirm client timeouts and clear error states.
5. Confirm the service worker never returns a cached form URL.
6. Confirm a denied join returns no form URL under any network condition.
7. Confirm the student `auth-login` path stays within the sign-in target under the cold sign-in burst.
8. Confirm login rate limiting does not lock out a legitimate student using the correct password.
9. Confirm a `session-join` response never contains the form link.
10. Confirm a retry of acknowledge or recover is denied after the grace boundary and cannot obtain the link.
11. Confirm the boundary rule under controlled clocks: recovery succeeds before the boundary and fails exactly at and after it.

---

## 10. Open questions

1. The exact load-tool choice and where the generators run.
2. The precise ramp shape and duration for the 1,500-user test.
3. The staging data volume used for the test.
4. Which Supabase plan and region, and the approved spending ceiling if free-tier limits are exceeded.
5. Preferred monitoring and alerting channel.
6. Whether activity event storage should be sampled to cut write volume and cost.
7. Whether the invigilator console uses Realtime or polling.
