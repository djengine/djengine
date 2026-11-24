'use strict';

// Türkçe karakterleri ve büyük/küçük harf farkını yok sayarak metni sadeleştirir.
// "LİNK", "Link", "lınk" ve "link" aynı kabul edilir.
const MAP = { ı: 'i', ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c', â: 'a', î: 'i', û: 'u' };

function normalize(text) {
  if (!text) return '';
  return String(text)
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ığüşöçâîû]/g, (c) => MAP[c] || c)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function parseKeywords(input) {
  if (Array.isArray(input)) return input.map((k) => String(k).trim()).filter(Boolean);
  return String(input || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// Anahtar kelime boşsa her mesaj eşleşir. Kelimeler tam kelime olarak aranır
// ("set" kelimesi "settings" içinde eşleşmez), çok kelimeli ifadeler de desteklenir.
function matchesKeywords(text, keywords) {
  const list = parseKeywords(keywords);
  if (list.length === 0) return true;
  const hay = ` ${normalize(text)} `;
  return list.some((k) => {
    const needle = normalize(k);
    return needle.length > 0 && hay.includes(` ${needle} `);
  });
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) =>
    vars && vars[key] != null ? String(vars[key]) : m
  );
}

function pickVariant(text, random = Math.random) {
  const variants = String(text || '')
    .split(/\n-{3,}\n|\n\|\|\n/) // "---" satırıyla ayrılmış alternatifler
    .map((v) => v.trim())
    .filter(Boolean);
  if (variants.length === 0) return '';
  return variants[Math.floor(random() * variants.length)];
}

module.exports = { normalize, parseKeywords, matchesKeywords, fillTemplate, pickVariant };
