// 執行：node --test carbon/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { STRINGS, LANGS } = require('../strings.js').CarbonStrings;

const params = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const base = STRINGS['zh-TW'];

test('四種語言都有相同的 key', () => {
    for (const lang of LANGS) {
        const keys = Object.keys(STRINGS[lang]);
        assert.deepEqual(Object.keys(base).filter(k => !keys.includes(k)), [], `${lang} 缺少`);
        assert.deepEqual(keys.filter(k => !(k in base)), [], `${lang} 多出`);
    }
});

test('每個 key 在各語言中的參數 {…} 相同、沒有空字串、沒有 HTML', () => {
    for (const lang of LANGS) {
        for (const [k, v] of Object.entries(STRINGS[lang])) {
            assert.equal(typeof v, 'string', `${lang}.${k}`);
            assert.ok(v.trim().length > 0, `${lang}.${k} 是空字串`);
            assert.ok(!/<[a-z/]/i.test(v), `${lang}.${k} 含 HTML`);
            assert.equal(params(v), params(base[k]), `${lang}.${k} 參數不一致`);
        }
    }
});

test('介面用到的交通方式、標籤都有文字', () => {
    const config = require('../carbon-config.json');
    for (const lang of LANGS) {
        for (const m of config.modes) assert.ok(STRINGS[lang]['mode.' + m], `${lang} mode.${m}`);
        for (const t of ['official', 'estimatedFactor', 'verifyStation']) assert.ok(STRINGS[lang]['tag.' + t]);
        for (const r of ['samePlace', 'seaCrossing', 'invalidPoint']) assert.ok(STRINGS[lang]['skip.' + r]);
    }
});
