'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, matchesKeywords, fillTemplate, pickVariant } = require('../src/core/match');

test('Türkçe karakter ve büyük harf farkı yok sayılır', () => {
  assert.equal(normalize('LİNK'), 'link');
  assert.equal(normalize('LINK'), 'link'); // Türkçe küçültmede "lınk" olurdu
  assert.equal(normalize('Şarkı Çalsın!'), 'sarki calsin');
  assert.ok(matchesKeywords('Bana LİNK atar mısın 🔥', 'link'));
  assert.ok(matchesKeywords('fiyat ne kadar?', 'Fiyat, booking'));
  assert.ok(matchesKeywords('Booking için yazdım', 'fiyat, booking'));
});

test('kelimeler tam kelime olarak aranır', () => {
  assert.ok(!matchesKeywords('settings', 'set'));
  assert.ok(matchesKeywords('SET listesi lütfen', 'set'));
  assert.ok(matchesKeywords('set!!!', 'set'));
});

test('çok kelimeli ifadeler', () => {
  assert.ok(matchesKeywords('bana da son mix lazım', 'son mix'));
  assert.ok(!matchesKeywords('son olarak mix', 'son mix'));
});

test('boş anahtar kelime her şeyle eşleşir', () => {
  assert.ok(matchesKeywords('ne olursa', ''));
  assert.ok(matchesKeywords('ne olursa', ' , '));
});

test('şablon ve varyasyon', () => {
  assert.equal(fillTemplate('Selam {username}!', { username: '@ali' }), 'Selam @ali!');
  assert.equal(fillTemplate('Selam {yok}', {}), 'Selam {yok}');
  assert.equal(pickVariant('A\n---\nB', () => 0.9), 'B');
  assert.equal(pickVariant('A\n---\nB', () => 0), 'A');
  assert.equal(pickVariant('Tek cevap'), 'Tek cevap');
});
