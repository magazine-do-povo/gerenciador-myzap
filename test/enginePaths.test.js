/**
 * enginePaths decide ONDE a sessão do WhatsApp mora. Errar aqui é a loja reler o QR.
 *
 * A regra: manifest.json de `myzap-pack` presente = layout novo (dados FORA, em
 * `myzap-data` ao lado); ausente = legado (dados DENTRO do motor, como sempre foi).
 */
const fs = require('fs'); const path = require('path'); const os = require('os');
const assert = require('assert');
const { isPackEngine, resolveDataDir, getEngineNodeExe } = require('../core/myzap/enginePaths');

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
const motor = path.join(raiz, 'myzap');
fs.mkdirSync(motor, { recursive: true });

// ── legado: sem manifest ────────────────────────────────────────────────────
assert.strictEqual(isPackEngine(motor), false, 'sem manifest tem de ser legado');
assert.strictEqual(resolveDataDir(motor), motor,
  'LEGADO: os dados ficam DENTRO do motor — mudar isso perde a sessao de quem ja esta instalado');
assert.strictEqual(getEngineNodeExe(motor), null, 'legado nao tem node embutido');
console.log('  ok  legado        dados em <motor>, sem node embutido');

// ── manifest de outro produto não conta ─────────────────────────────────────
fs.writeFileSync(path.join(motor, 'manifest.json'), JSON.stringify({ name: 'outra-coisa' }));
assert.strictEqual(isPackEngine(motor), false, 'manifest de outro name NAO pode virar pack');
console.log('  ok  manifest alheio  ignorado (continua legado)');

// ── manifest quebrado não derruba ───────────────────────────────────────────
fs.writeFileSync(path.join(motor, 'manifest.json'), 'nao e json {{');
assert.strictEqual(isPackEngine(motor), false, 'manifest corrompido nao pode estourar');
console.log('  ok  manifest quebrado  tratado como legado');

// ── pack: dados FORA ────────────────────────────────────────────────────────
fs.writeFileSync(path.join(motor, 'manifest.json'), JSON.stringify({ name: 'myzap-pack', version: '3.0.20' }));
assert.strictEqual(isPackEngine(motor), true);
const dados = resolveDataDir(motor);
assert.notStrictEqual(dados, motor, 'PACK: os dados NAO podem ficar dentro do motor (a troca apagaria)');
assert.strictEqual(path.dirname(dados), path.dirname(motor), 'myzap-data fica AO LADO do motor');
console.log(`  ok  pack          dados em ${path.basename(dados)}, ao lado do motor`);

fs.rmSync(raiz, { recursive: true, force: true });
console.log('\n  OK — 4 cenarios');
