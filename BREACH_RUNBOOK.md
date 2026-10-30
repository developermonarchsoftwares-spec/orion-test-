# Personal data breach runbook (DPDP Act, India)

**Status: DRAFT for legal review.** The statutory references and deadlines below reflect our reading of the Digital Personal Data Protection Act, 2023 and the DPDP Rules; counsel must confirm them, the template wording and the contact details before this is relied on. Items in `[square brackets]` must be filled in. This runbook adds the *notification* steps to the existing technical runbook, `docs/INCIDENT_RESPONSE_RUNBOOK.md` (detection, containment, evidence); use both together.

## 1. What counts as a personal data breach
Any unauthorised processing, or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access to personal data, that compromises its confidentiality, integrity or availability. In Orion that includes, for example:

- a database dump, backup, export file or storage bucket exposed or accessed by someone not entitled to it;
- stolen or leaked JWT secrets, API keys, refresh tokens or integration credentials that let someone read accounts;
- an authorisation bug that shows one customer another's data, unlocked contacts or exports;
- the directory data (names, work e-mails, phones of decision makers) copied out in bulk without unlocking;
- a mis-sent e-mail containing other people's data, or a lost/stolen device with a session or data export.

When unsure, treat it as a breach and start the clock (section 3). Downgrading later is cheap; a missed deadline is not.

## 2. Roles `[fill in names and 24x7 phone numbers]`
| Role | Person | Does |
|---|---|---|
| Incident lead | `[name]` | Runs the response, keeps the log, decides severity |
| Engineering lead | `[name]` | Containment, evidence, root cause, fix |
| Grievance Officer / privacy contact | `[name, privacy@monarchsoftwares.com]` | Drafts and sends notices, talks to the Board and users |
| Legal counsel | `[name / firm]` | Decides whether and how to notify; approves notice text |
| Management approver | `[name]` | Signs off notices and public statements |

## 3. Timeline
`T0` = the moment anyone at Monarch Softwares first becomes aware of a *possible* breach. Write the time down.

| When | Action | Owner |
|---|---|---|
| T0 to +1 h | Open an incident record (section 4). Page the incident lead and engineering lead. Start the evidence log. | Whoever noticed |
| T0 to +4 h | Contain (section 5). Preserve logs and snapshots **before** rotating or deleting anything. | Engineering |
| T0 to +6 h | **CERT-In:** report a qualifying cyber incident to CERT-In within 6 hours of noticing it (CERT-In Directions, 2022; counsel to confirm applicability). | Incident lead |
| T0 to +24 h | First assessment: what data, whose, how many, how, is it still happening (section 6). Counsel decides if it is a notifiable personal data breach. | Incident lead + counsel |
| **As soon as notifiable** | **Tell the Data Protection Board of India without delay** (short initial intimation, template 8.1) **and tell each affected person without delay** (template 8.2). | Grievance Officer |
| **Within 72 hours of becoming aware** | **Send the Board the detailed report** (template 8.3), or within any longer period the Board allows in writing. | Grievance Officer |
| +72 h to +30 days | Complete the fix, answer the Board, keep affected people informed, run the review (section 9). | Engineering + lead |

If the 72-hour detailed report cannot be complete, send what is known on time and say what is still being established. Do not wait for certainty.

## 4. Open the incident record
Create one file per incident, `incidents/YYYY-MM-DD-short-name.md` kept **outside the repository's public branches** (it will name affected people). Record: T0; who noticed and how; every action with a timestamp and the person; every decision and who made it; what evidence was saved and where. Never paste secrets, passwords or full personal data into it; refer to row counts and ids.

## 5. Contain (see `docs/INCIDENT_RESPONSE_RUNBOOK.md` for commands)
Pick what fits; record each step.
1. **Stop the leak:** disable the affected feature, route or integration; block the offending IP/key; take a public bucket or object URL private.
2. **Credentials:** rotate `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` together on the API and the web app (this signs everyone out); revoke refresh tokens, API keys and integration credentials that may be exposed; rotate database, storage, Resend, Razorpay and OAuth secrets as needed. **Warning:** the encryption keys for stored MFA seeds and integration credentials are derived from `JWT_ACCESS_SECRET` unless `MFA_ENCRYPTION_KEY` / `INTEGRATIONS_ENCRYPTION_KEY` are set; rotating the JWT secret without a separate key makes those stored secrets unreadable (users must re-enrol MFA, integrations must be reconnected). Plan for this before rotating.
3. **Preserve evidence first:** export the `audit_logs` rows for the period, application and platform logs, a database snapshot/backup, storage access logs. Note hashes and times.
4. **Protect people:** force password resets or MFA re-enrolment for affected accounts; suppress affected exports; set `data_status`/suppression on exposed directory records if needed.

## 6. Assess (answer in the incident record)
- **What** personal data (identifiers, credentials, contact data, payment identifiers, uploaded files, directory contacts)? Any credentials or financial data?
- **Whose**: Orion customers, people in the directory, both? How many of each? Any children? Which states/countries?
- **How and when**: cause, first and last time of unauthorised access, how it was found, whether it has stopped.
- **Who** had access (known actor, unknown, an employee or vendor)?
- **Likely impact** on the people (spam/phishing, fraud, harassment, loss of access, reputational harm).
- **Safeguards that held** (hashes, encryption, tokens expired).
Counsel then records the decision: notifiable or not, and why. Keep the reasoning even when the answer is "not notifiable".

## 7. Who to tell, in what order
1. Management approver and counsel (immediately).
2. CERT-In (within 6 hours, if applicable).
3. The Data Protection Board of India (initial: without delay once notifiable; detailed: within 72 hours).
4. Each affected person (without delay, individually, in plain language). If many, e-mail all and put a notice on the site; keep proof of sending.
5. Payment processor, cloud provider and other processors whose data or systems are involved, as their contracts require.
6. Law enforcement where there is a crime, on counsel's advice.

## 8. Templates (counsel to approve before use)

### 8.1 Initial intimation to the Data Protection Board of India
> **Subject:** Intimation of personal data breach: [Data Fiduciary name], [date]
>
> To: The Data Protection Board of India `[address / portal reference as prescribed]`
>
> 1. **Data Fiduciary:** [Monarch Softwares / registered name], [registered address], product "Orion". Contact: [Grievance Officer name, e-mail, phone].
> 2. **Date and time we became aware:** [T0, IST].
> 3. **Brief description of the breach:** [what happened in two or three sentences].
> 4. **Nature and extent:** [categories of personal data, approximate number of Data Principals, whether credentials or financial data are involved].
> 5. **Timing and location:** [when it started and ended or whether it continues; systems and place].
> 6. **Likely impact on Data Principals:** [harm that could follow].
> 7. **Steps taken so far:** [containment].
> 8. **Next:** we will send the detailed report within 72 hours of becoming aware, that is by [date and time].
>
> [Name, designation, date]

### 8.2 Notice to each affected person
> **Subject:** Important: a security incident involving your personal data at Orion
>
> Dear [name],
>
> We are writing to tell you about a security incident that involved some of your personal data held by Orion, a Monarch Softwares product.
>
> **What happened:** [plain description, including when it happened and when we found out].
> **What information was involved:** [exactly which of your details].
> **What this could mean for you:** [likely consequences, for example phishing or spam, and whether passwords or payment details were affected].
> **What we have done:** [containment, fixes, who we have informed].
> **What you can do:** [change your password at [link]; be careful with unexpected messages claiming to be from us; keep an eye on [account/statement] ; enable two-step sign-in].
> **Who to contact:** [Grievance Officer name], [e-mail], [phone], [hours]. You may also complain to the Data Protection Board of India.
>
> We are sorry that this happened.
> [Name, designation], Monarch Softwares

Send individually from a verified sender; never ask for passwords, OTPs or card details in this message; keep a record of who was sent it and when.

### 8.3 Detailed report to the Data Protection Board of India (within 72 hours)
> **Subject:** Detailed report: personal data breach, [Data Fiduciary name], ref [our incident id]
>
> 1. **Updated particulars** of the initial intimation of [date].
> 2. **Broad facts of the breach:** [nature, extent, date(s), location].
> 3. **Cause:** [events and circumstances that led to it; root cause].
> 4. **Findings about the person responsible**, if any: [known / unknown / insider / vendor / external].
> 5. **Mitigation:** [steps taken and planned to contain and reduce risk].
> 6. **Remedial measures:** [fixes to stop recurrence, with dates].
> 7. **Intimation to Data Principals:** [how, when, to how many; copy of the notice attached].
> 8. **Number and categories** of Data Principals and data affected: [figures].
> 9. **Contact:** [Grievance Officer].
>
> [Name, designation, date]

## 9. After the incident (within 30 days)
- Blameless review: timeline, root cause, what detection or control failed, what worked.
- Fix the cause and add a test that would have caught it (the project keeps one test per fixed bug).
- Update `docs/SECURITY_RISK_REGISTER.md`, this runbook and the Privacy Notice if practices change.
- Record the breach in the breach register (date, summary, numbers, decision, notices sent and when). Keep logs and records of the incident and the notices for at least the period the DPDP Rules require (counsel to confirm; assumed one year or more).
- Tell the Board and affected people if the facts change materially.

## 10. Open items before this runbook is usable
- Fill in roles, phone numbers and the Board's prescribed submission channel.
- Counsel to confirm the "without delay", 72-hour and record-keeping requirements, CERT-In applicability, and the template wording.
- Rehearse once as a table-top exercise and record the date here: `[date]`.
- Set `MFA_ENCRYPTION_KEY` and `INTEGRATIONS_ENCRYPTION_KEY` separately in production so a secret rotation does not lose stored secrets (see DPDP_PROGRESS.md security gaps).
