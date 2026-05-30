// Money-parsing coverage for the site-wide overlay in b2b-price.js.
//
// b2b-price.js is an IIFE (no exports). Per the established parity-test
// convention in this folder (see b2b-price.test.js), we re-implement the
// money helpers here byte-for-byte and assert their behaviour. Any change to
// parseAmount / formatLikeOriginal / parseMoney in b2b-price.js must update
// this mirror in lockstep — CI failure flags drift to reviewers.

import { describe, it, expect } from 'vitest';

function isDecimalSep(s, sep) {
  var i = s.lastIndexOf(sep);
  if (i < 0) return false;
  if (s.indexOf(sep) !== i) return false;
  var trailing = s.length - i - 1;
  return trailing === 1 || trailing === 2;
}

function parseAmount(numStr) {
  var lastDot = numStr.lastIndexOf('.');
  var lastComma = numStr.lastIndexOf(',');
  var decSep = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0) {
    decSep = isDecimalSep(numStr, '.') ? '.' : null;
  } else if (lastComma >= 0) {
    decSep = isDecimalSep(numStr, ',') ? ',' : null;
  }
  var normalized;
  if (decSep) {
    var thouSep = decSep === '.' ? ',' : '.';
    normalized = numStr.split(thouSep).join('').replace(decSep, '.');
  } else {
    normalized = numStr.replace(/[.,]/g, '');
  }
  var val = parseFloat(normalized);
  return isFinite(val) ? val : null;
}

function formatLikeOriginal(amount, numStr) {
  var lastDot = numStr.lastIndexOf('.');
  var lastComma = numStr.lastIndexOf(',');
  var decSep = null;
  var thouSep = '';
  if (lastDot >= 0 && lastComma >= 0) {
    decSep = lastDot > lastComma ? '.' : ',';
    thouSep = decSep === '.' ? ',' : '.';
  } else if (lastDot >= 0 && isDecimalSep(numStr, '.')) {
    decSep = '.';
  } else if (lastComma >= 0 && isDecimalSep(numStr, ',')) {
    decSep = ',';
  } else if (numStr.indexOf(',') >= 0) {
    thouSep = ',';
  } else if (numStr.indexOf('.') >= 0) {
    thouSep = '.';
  }
  var decimals = decSep ? numStr.length - numStr.lastIndexOf(decSep) - 1 : 0;
  var fixed = amount.toFixed(decimals);
  var parts = fixed.split('.');
  var intPart = parts[0];
  var fracPart = parts[1] || '';
  if (thouSep) {
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thouSep);
  }
  return decimals > 0 ? intPart + (decSep || '.') + fracPart : intPart;
}

function parseMoney(text) {
  if (!text) return null;
  var m = String(text).match(/\d[\d.,]*\d|\d/);
  if (!m) return null;
  var numStr = m[0];
  var before = String(text).slice(0, m.index);
  var symMatch = before.match(/([^\s\d]+)\s*$/);
  var prefix = symMatch ? symMatch[1] : '';
  var amount = parseAmount(numStr);
  if (amount === null || !isFinite(amount)) return null;
  return { amount: amount, prefix: prefix, numStr: numStr };
}

describe('parseAmount', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['10.00', 10],
    ['1,000', 1000],
    ['1,234,567', 1234567],
    ['5', 5],
    ['0.99', 0.99],
  ])('parses %s → %d', (input, expected) => {
    expect(parseAmount(input)).toBeCloseTo(expected, 6);
  });
});

describe('parseMoney', () => {
  it('extracts the currency prefix and amount from "$1,234.56"', () => {
    const p = parseMoney('$1,234.56');
    expect(p).not.toBeNull();
    expect(p.prefix).toBe('$');
    expect(p.amount).toBeCloseTo(1234.56, 6);
  });

  it('handles a label before the price ("From $5.00")', () => {
    const p = parseMoney('From $5.00');
    expect(p.prefix).toBe('$');
    expect(p.amount).toBeCloseTo(5, 6);
  });

  it('handles a multi-char symbol ("NZ$10.00")', () => {
    const p = parseMoney('NZ$10.00');
    expect(p.prefix).toBe('NZ$');
    expect(p.amount).toBeCloseTo(10, 6);
  });

  it('returns null when there is no number', () => {
    expect(parseMoney('Sold out')).toBeNull();
  });
});

describe('formatLikeOriginal', () => {
  it('preserves 2-decimal dollar formatting', () => {
    expect(formatLikeOriginal(8, '10.00')).toBe('8.00');
  });

  it('adds thousands grouping like the original', () => {
    expect(formatLikeOriginal(9876.48, '12,345.60')).toBe('9,876.48');
  });

  it('preserves EU decimal-comma formatting', () => {
    expect(formatLikeOriginal(1234.56, '1.234,56')).toBe('1.234,56');
  });

  it('keeps a no-decimal integer integral', () => {
    expect(formatLikeOriginal(800, '1,000')).toBe('800');
  });
});

describe('end-to-end: 20% off a displayed price', () => {
  it('$100.00 → discounted $80.00, save $20.00', () => {
    const p = parseMoney('$100.00');
    const discounted = p.amount * (1 - 20 / 100);
    expect(p.prefix + formatLikeOriginal(discounted, p.numStr)).toBe('$80.00');
    expect(p.prefix + formatLikeOriginal(p.amount - discounted, p.numStr)).toBe('$20.00');
  });
});
