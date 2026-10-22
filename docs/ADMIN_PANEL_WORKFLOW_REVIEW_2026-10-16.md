# Admin panel workflow review (2026-10-16)

Scope: the admin panel at `/admin/monarch` (`ownus/src/app/admin/monarch/page.tsx` and `ownus/src/components/admin/*`) and the server
routes behind it. Method: every action handler in the panel was classified by reading it (does it call the server, or only change screen
state?); every page route was fetched; the server-side admin workflows were run through the admin test suites; the data each screen loads
was traced to its source. **What was NOT done:** a signed-in click-through of the live panel. Admin sign-in needs an e-mailed one-time code,
and the browser pane does not keep a session across reloads, so no admin session was available. Findings below come from code and tests,
not from watching the live UI.

## 1. Summary
| | |
|---|---|
| Server-side admin workflows (auth, import, people import, publication, exports, audit) | **Working**: 11 admin-related test suites, 205 tests, all pass |
| Admin pages load | **Yes**: `/admin/monarch` answers 200; `/admin` returns 404 on purpose |
| Panel actions that really save to the database | Business status changes (approve, draft, publish), single and bulk delete, bulk status, import preview/submit, People import and review, sign-in/out |
| Panel actions that only change the screen (lost on reload, no server effect) | **About 35 of 45 handlers**, including some that show a success message claiming a real effect (section 3) |
| Highest-impact bugs | A-1 Reject is not saved, A-2 customer and transaction/refund actions are not saved, A-3 "system" buttons only pretend |

## 2. Screens, by how real they are
`Real` = loads from the server and saves changes. `Read-only real` = loads from the server, edits are screen-only. `Screen-only` = no
server data and no server saves (it starts empty or from built-in sample data).

| Screen (tab) | Status | Notes |
|---|---|---|
| Dashboard | Real (derived) | Counts come from the loaded business records |
| Business records | **Real** | List, status change, delete and bulk operations are saved. Internal notes are screen-only |
| Import data / Import history | **Real** | Preview and submit go through the gateway to the API and the import pipeline |
| Data validation | **Partly real** | Approve and Move to Draft are saved. **Reject and Bulk Reject are not** (A-1) |
| Duplicate manager | Screen-only | Merge, keep, ignore and delete act on pairs found in the browser during import; nothing is sent to the server (A-4) |
| Publish queue, Upload operations, People import, Data quality, People review | **Real** | Their own API calls; covered by the passing suites |
| Enrichment, Published, Reports | Mixed / not fully traced | Reports builds files in the browser; the rest was not traced line by line |
| Users management | **Read-only real** | The list loads from the server. Add, edit and delete are screen-only (A-2) |
| Credits & transactions | **Read-only real** | The list loads. Adding a transaction and changing a status (including Refunded) are screen-only (A-2) |
| Roles & permissions | Screen-only | Built-in sample matrix; real access control is the server-side ADMIN / SUPER_ADMIN check, so this screen does not control anything (A-5) |
| Activity logs | Read-only real | The list loads from the server. Entries the panel adds locally carry a made-up address (`192.168.1.1`) and are not the real audit trail |
| Support center | Screen-only | Tickets exist only in the browser |
| Data intelligence, Data sources, Enrichment queue, AI processing, Automation, Sync center | Screen-only | Start empty (or sample pipelines); actions change screen state |
| System health | Screen-only | See A-3 |
| Settings | Not traced | |

## 3. Findings

### A-1 Reject and Bulk Reject are not saved (High)
`handleRejectRecord` and `handleBulkRejectValidation` only update the browser's copy of the records. The server already supports a
REJECTED status (the gateway maps it), and `handleStatusChange` is the function that saves status changes; Reject never calls it. After a
reload the record is back in its earlier state, so a rejected record can be approved or published later by mistake. Approve, Move to Draft,
Delete and Bulk Approve are saved.
Fix: have Reject use the same saving path as Approve (single and bulk), then close the window.

### A-2 Customer and transaction actions look saved but are not (High)
- Users: Add customer, Edit customer and **Delete customer** change the screen only. Message shown: "Customer account CUST-… deleted."
- Credits: Add transaction and **change a transaction to Refunded/other status** change the screen only. Message: "Transaction … status updated to …".
- The server has real endpoints for this (`credit/admin/adjust`, `billing/admin/refunds`) with limits, audit and rules, but the panel does not call them.
An administrator can believe a refund was issued or an account removed when nothing happened, and a real customer's balance is untouched.
Fix: wire these actions to the real endpoints, or disable the buttons and say so.

### A-3 System buttons only pretend (Medium)
"Rebuild index" (toast: "Rebuilt Elasticsearch master indices…"), "Optimize index", "Flush cache" (toast: "Flushed Redis in-memory search caches
across all regions") and "Restart service" (toast: "Successfully restarted microservice pod…") only change on-screen numbers. The app does not
use Elasticsearch (the active search provider is PostgreSQL) and the buttons contact no service.
Fix: remove them, label them as a preview, or connect them to real operations.

### A-4 Duplicate resolution is not saved (Medium)
Duplicate pairs come only from the browser's own comparison during import. Merge, Keep, Ignore, Delete and Bulk Merge change local state
and (for merge/delete) remove records from the on-screen list, but nothing reaches the server, so the database still holds both records.
The API has a duplicate-review service (`review.service`, `duplicate-review.repositories`) that this screen does not use.

### A-5 The Roles & permissions matrix does not control access (Medium, misleading)
It edits a sample matrix. Real permissions are decided on the server (all 83 privileged routes allow ADMIN and SUPER_ADMIN; see R-035
in `SECURITY_RISK_REGISTER.md`). Changing a role here gives a false sense of restricting an administrator.

### A-6 Smaller issues
- Internal notes on a record are kept in the browser only.
- Activity log entries created by the panel use a hardcoded address and name, and use "Automated Payment Gateway" as the actor for manual transactions.
- Success toasts are shown even for the screen-only actions above; there is no "not saved" indication.
- Import batch IDs and some customer/transaction IDs are generated with `Math.random()` in the browser (display only).

### Already fixed during this review series
- Approve Record now closes the validation window (earlier today).
- Website validation: one shared rule; the false "missing website" warning and the `row.website` vs `row.Website` mismatch.
- Gateway forwarded the client's own `X-Forwarded-For` (rate-limit bypass risk).

## 4. What was verified
| Check | Result |
|---|---|
| Admin e2e suites (admin-auth, admin-authorization, admin-session, admin-import-pipeline, admin-people-import, privileged-operations, import-export, people-lifecycle, provenance-publishing, audit-logging, export-security) | 11 suites, 205 tests passed, 1 todo |
| Admin page routes | `/admin/monarch` 200, `/admin` 404 (by design) |
| Handler audit | 45 handlers read or classified; the saved/not-saved split above |
| Whole-project suites run earlier today | API unit 1884, integration 984, e2e 731, web 332, all passed |

## 5. Recommended order
1. A-1: make Reject (and Bulk Reject) save, because it affects what can be published.
2. A-2: connect customer and refund actions to the real endpoints, or disable them.
3. A-3 and A-5: remove or relabel the simulated controls so they cannot be mistaken for real operations.
4. A-4: connect duplicate resolution to the API's review service.
5. Then a signed-in click-through of each tab (needs an admin session) to catch layout and flow problems that code reading cannot show.
