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

test('одобрил: статус и строка журнала', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'одобрил', {}, LATER);
  assert.equal(s.getDraft('d-e1').status, 'одобрен');
  assert.deepEqual(s.ownerActions().map((a) => [a.action, a.draft_id, a.created_at]), [['одобрил', 'd-e1', LATER]]);
});

test('отклонил: причина необязательна', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'отклонил', { reason: 'не наша тема' }, LATER);
  assert.equal(s.getDraft('d-e1').status, 'отклонён владельцем');
  assert.deepEqual(s.ownerActions()[0].detail, { reason: 'не наша тема' });
});

test('поправил: текст до и после в журнале, статус остаётся', () => {
  const s = fixture();
  s.ownerAct('d-e1', 'поправил', { text: ' Новый текст ', gateOk: true }, LATER);
  const d = s.getDraft('d-e1');
  assert.equal(d.text, 'Новый текст');
  assert.equal(d.status, 'ждёт одобрения');
  assert.deepEqual(s.ownerActions({ draftId: 'd-e1' })[0].detail, { before: 'Текст поста', after: 'Новый текст' });
});

test('правка без ворот, пустая и повторное действие отклоняются, журнал не растёт', () => {
  const s = fixture();
  assert.throws(() => s.ownerAct('d-e1', 'поправил', { text: 'x', gateOk: false }), /ворота/);
  assert.throws(() => s.ownerAct('d-e1', 'поправил', { text: '  ', gateOk: true }), /пустой/);
  assert.throws(() => s.ownerAct('d-e1', 'нечто'), /неизвестное/);
  assert.equal(s.ownerActions().length, 0);
  s.ownerAct('d-e1', 'одобрил', {}, LATER);
  assert.throws(() => s.ownerAct('d-e1', 'отклонил'), /не ждёт/);
  assert.equal(s.ownerActions().length, 1);
});

test('нет черновика — ошибка', () => {
  assert.throws(() => openStore(':memory:').ownerAct('d-nope', 'одобрил'), /нет черновика/);
});
