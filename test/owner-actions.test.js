import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

const NOW = '2026-10-28T10:00:00.000Z';
const LATER = '2026-10-28T11:00:00.000Z';

function fixture() {
  const s = openStore(':memory:');
  s.upsert({ id: 'e1', title: 'Событие', firstSeen: NOW, independentSources: 2, score: 70, reasons: [], needsOwner: false, sources: [{ source: 'x', name: 'X', link: 'https://example.com/1', published: NOW }] }, NOW);
  s.addDraft({ eventId: 'e1', style: 'срочно', text: 'Текст поста', gateOk: true, reasons: [] }, NOW);
  return s;
}

test('одобрил (approve): status and journal row', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'одобрил', {}, LATER);
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  assert.deepEqual(s.ownerActions().map((a) => [a.action, a.draft_id, a.created_at]), [['одобрил', 'd-e1', LATER]]);
});

test('отклонил (reject): reason is optional', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'отклонил', { reason: 'не наша тема' }, LATER);
  assert.equal(s.getDraft('d-e1').status, 'отклонён владельцем');
  assert.deepEqual(s.ownerActions()[0].detail, { reason: 'не наша тема' });
});

test('поправил (edit): text before and after in the journal, status unchanged', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'поправил', { text: ' Новый текст ', gateOk: true }, LATER);
  const d = s.getDraft('d-e1');
  assert.equal(d.text, 'Новый текст');
  assert.equal(d.status, 'ждёт одобрения');
  assert.deepEqual(s.ownerActions({ draftId: 'd-e1' })[0].detail, { before: 'Текст поста', after: 'Новый текст' });
});

test('an edit without the gate, an empty one and a repeated action are rejected; the journal does not grow', () => {
  const s = fixture();
  assert.throws(() => s.ownerAct('d-e1', 'поправил', { text: 'x', gateOk: false }), /gate/);
  assert.throws(() => s.ownerAct('d-e1', 'поправил', { text: '  ', gateOk: true }), /empty/);
  assert.throws(() => s.ownerAct('d-e1', 'нечто'), /unknown/);
  assert.equal(s.ownerActions().length, 0);
  s.ownerAct('d-e1', 'одобрил', {}, LATER);
  assert.throws(() => s.ownerAct('d-e1', 'отклонил'), /no longer awaiting/);
  assert.equal(s.ownerActions().length, 1);
});

test('no draft — error', () => {
  assert.throws(() => openStore(':memory:').ownerAct('d-nope', 'одобрил'), /no draft/);
});

test('feed marks: важно / не то (important / not it) are written to the journal; draft status unchanged', () => {
  const s = fixture();
  s.ownerMark('d-e1', 'важно', {}, LATER);
  s.ownerMark('d-e1', 'не то', { reason: 'повтор' }, LATER);
  assert.deepEqual(s.ownerActions().map((a) => [a.action, a.detail]), [['не то', { reason: 'повтор' }], ['важно', {}]]);
  assert.equal(s.getDraft('d-e1').status, 'ждёт одобрения');
  assert.throws(() => s.ownerMark('d-e1', 'одобрил'), /unknown mark/);
  assert.throws(() => s.ownerMark('нет', 'важно'), /no draft/);
});
