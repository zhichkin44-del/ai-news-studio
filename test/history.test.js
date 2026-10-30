import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalReason } from '../src/history.js';

test('историческая справка: годовщины и «N лет назад» — не новости', () => {
  assert.ok(historicalReason('Испытания "Царь-бомбы" на Новой-Земле прошли 65 лет назад'));
  assert.ok(historicalReason('В этот день: 30 октября'));
  assert.ok(historicalReason('Годовщина падения Берлинской стены'));
  assert.ok(historicalReason('Исполнилось 80 лет со дня победы'));
  assert.ok(historicalReason('В 1961 году СССР испытал бомбу'));
});

test('настоящие новости проходят, в том числе с прошлым в тексте', () => {
  assert.equal(historicalReason('Землетрясение магнитудой 5,5 произошло около Токио'), null);
  assert.equal(historicalReason('Google выпустил Gemini 4 Carbon'), null);
  assert.equal(historicalReason('Суд приговорил к 15 годам бывшего министра'), null);
  assert.equal(historicalReason('Курс доллара обновил максимум за 3 года'), null);
});
