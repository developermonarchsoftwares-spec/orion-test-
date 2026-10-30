import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkDecision, daysLeft, dueBadge, guidance, isClosed, overdueCount, queueApi, type IDecisionInput, type IQueueDetail, type IQueueRow } from '../rights-queue.ts';

/** The admin rights queue: deadlines, the checks that mirror the server, the API calls, and that the screen is reachable. */
const src = (...p: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const row = (over: Partial<IQueueRow> = {}): IQueueRow => ({
  reference: 'DR-AAAAAAAAAA', type: 'ACCESS', status: 'REQUESTED', contactEmail: 'asha@example.com', requesterNote: 'OTHER: Asha', details: null,
  verifiedAt: null, dueAt: days(20), createdAt: days(-10), completedAt: null, ...over,
});
const detail = (r: IQueueRow, people: IQueueDetail['found']['people'] = []): IQueueDetail => ({ ...r, evidence: 'NONE', publicMessage: null, decisionReason: null, resultSummary: null, found: { customerAccount: false, companyContacts: 0, people } });
const decision = (over: Partial<IDecisionInput> = {}): IDecisionInput => ({ action: 'COMPLETE', message: '', reason: '', identityChecked: false, ...over });

describe('deadlines', () => {
  it('counts whole days and labels overdue, due today, soon and fine', () => {
    assert.equal(daysLeft(days(3), NOW), 3);
    assert.deepEqual(dueBadge(days(-2), NOW), { label: '2 days overdue', tone: 'overdue' });
    assert.deepEqual(dueBadge(days(-1), NOW), { label: '1 day overdue', tone: 'overdue' });
    assert.deepEqual(dueBadge(days(0), NOW), { label: 'Due today', tone: 'soon' });
    assert.deepEqual(dueBadge(days(1), NOW), { label: '1 day left', tone: 'soon' });
    assert.deepEqual(dueBadge(days(5), NOW), { label: '5 days left', tone: 'soon' });
    assert.deepEqual(dueBadge(days(6), NOW), { label: '6 days left', tone: 'ok' });
  });
  it('only open requests past their deadline are overdue', () => {
    const rows = [row({ dueAt: days(-3) }), row({ dueAt: days(-3), status: 'COMPLETED' }), row({ dueAt: days(4) }), row({ dueAt: days(-1), status: 'NEEDS_INFO' })];
    assert.equal(overdueCount(rows, NOW), 2);
    assert.equal(isClosed('REJECTED'), true);
    assert.equal(isClosed('APPROVED'), false);
  });
});

describe('checks that mirror the server', () => {
  it('asking and rejecting need a message; a rejection also needs an internal reason', () => {
    assert.match(checkDecision(row(), null, decision({ action: 'REQUEST_INFO' }))!, /what you need/);
    assert.equal(checkDecision(row(), null, decision({ action: 'REQUEST_INFO', message: 'Which company?' })), null);
    assert.match(checkDecision(row(), null, decision({ action: 'REJECT', message: 'No, sorry.' }))!, /internal reason/);
    assert.equal(checkDecision(row(), null, decision({ action: 'REJECT', message: 'No, sorry.', reason: 'Fraud risk.' })), null);
  });
  it('an access, correction, withdrawal or nomination needs the identity confirmation; a grievance does not', () => {
    for (const type of ['ACCESS', 'CORRECTION', 'WITHDRAWAL', 'NOMINATION']) {
      assert.match(checkDecision(row({ type }), null, decision())!, /who the requester is/, type);
      assert.equal(checkDecision(row({ type }), null, decision({ identityChecked: true })), null, type);
    }
    assert.equal(checkDecision(row({ type: 'GRIEVANCE' }), null, decision()), null);
  });
  it('an erasure needs the confirmed address and every matching person suppressed', () => {
    const e = row({ type: 'ERASURE' });
    assert.match(checkDecision(e, null, decision())!, /not confirmed/);
    const confirmed = row({ type: 'ERASURE', verifiedAt: days(-1), status: 'APPROVED' });
    const visible = detail(confirmed, [{ id: 'p1', fullName: 'Asha Rao', dataStatus: 'PUBLISHED' }, { id: 'p2', fullName: 'A R', dataStatus: 'SUPPRESSED' }]);
    assert.match(checkDecision(confirmed, visible, decision())!, /1 matching person record\(s\) are not suppressed/);
    const done = detail(confirmed, [{ id: 'p1', fullName: 'Asha Rao', dataStatus: 'SUPPRESSED' }]);
    assert.equal(checkDecision(confirmed, done, decision()), null);
    assert.equal(checkDecision(confirmed, detail(confirmed), decision()), null);
  });
  it('a closed request, or one whose address was already cleared, cannot be decided', () => {
    assert.match(checkDecision(row({ status: 'COMPLETED' }), null, decision({ identityChecked: true }))!, /already closed/);
    assert.match(checkDecision(row({ contactEmail: null }), null, decision({ identityChecked: true }))!, /no longer held/);
  });
  it('tells the reviewer what to do next', () => {
    assert.match(guidance(row({ type: 'ERASURE' }), null), /Waiting for the requester/);
    const confirmed = row({ type: 'ERASURE', verifiedAt: days(-1) });
    assert.match(guidance(confirmed, detail(confirmed, [{ id: 'p', fullName: 'X', dataStatus: 'PUBLISHED' }])), /People Review/);
    assert.match(guidance(confirmed, detail(confirmed)), /can complete/);
    assert.match(guidance(row({ status: 'REJECTED' }), null), /cleared/);
    assert.match(guidance(row({ type: 'GRIEVANCE' }), null), /Data Protection Board/);
  });
});

describe('API calls', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake = (status: number, body: unknown) => async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  it('lists open and closed requests, unwrapping the API envelope', async () => {
    calls.length = 0;
    const api = queueApi('/api/v1', fake(200, { success: true, data: [row()] }));
    assert.equal((await api.list(false)).length, 1);
    await api.list(true);
    assert.deepEqual(calls.map((c) => c.url), ['/api/v1/privacy/admin/rights-requests', '/api/v1/privacy/admin/rights-requests?closed=true']);
  });
  it('puts only the reference in the URL, never the requester address', async () => {
    calls.length = 0;
    const api = queueApi('/api/v1', fake(200, { data: { reference: 'DR-AAAAAAAAAA', status: 'COMPLETED' } }));
    await api.detail('DR-AAAAAAAAAA');
    await api.decide('DR-AAAAAAAAAA', decision({ message: ' Done. ', identityChecked: true }));
    assert.ok(calls.every((c) => !c.url.includes('@')));
    assert.equal(calls[1].url, '/api/v1/privacy/admin/rights-requests/DR-AAAAAAAAAA/decision');
    assert.deepEqual(JSON.parse(String(calls[1].init!.body)), { action: 'COMPLETE', message: 'Done.', identityChecked: true });
  });
  it('turns an error answer into an Error carrying the status and code', async () => {
    const api = queueApi('/api/v1', fake(409, { message: 'Confirm that you checked who the requester is.', errorCode: 'IDENTITY_NOT_CHECKED' }));
    await assert.rejects(api.decide('DR-AAAAAAAAAA', decision()), (e: any) => e.status === 409 && e.errorCode === 'IDENTITY_NOT_CHECKED' && /checked who/.test(e.message));
  });
});

describe('the screen is reachable', () => {
  it('has a sidebar entry, a header, a tab type and is rendered by the console', () => {
    assert.match(src('components', 'admin', 'admin-sidebar.tsx'), /id: 'rights_queue', label: 'Privacy Requests'/);
    assert.match(src('components', 'admin', 'admin-header.tsx'), /rights_queue: \{/);
    assert.match(src('types', 'admin.ts'), /\| 'rights_queue'/);
    assert.match(src('app', 'admin', 'monarch', 'page.tsx'), /activeTab === 'rights_queue' && <RightsQueueView \/>/);
  });
  it('sends decisions with the administrator session and tells the reviewer a decision is e-mailed first', () => {
    const view = src('components', 'admin', 'views', 'rights-queue-view.tsx');
    assert.match(view, /queueApi\(apiClient\.getBaseUrl\(\), adminFetch\)/);
    assert.match(view, /Sent by e-mail before anything changes/);
    assert.match(view, /Suppress these people in People Review/);
  });
});
