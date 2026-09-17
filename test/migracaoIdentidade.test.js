const fs = require('fs'); const path = require('path'); const os = require('os');
const assert = require('assert');
const { migrarConfiguracaoDaIdentidadeAntiga } = require('../core/migracaoIdentidade');

function cenario(nome, montar) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const antiga = path.join(raiz, 'gerenciador-myzap');
  const nova = path.join(raiz, 'gerenciador-myzap-mdp');
  montar({ antiga, nova });
  const r = migrarConfiguracaoDaIdentidadeAntiga({ getPath: () => nova });
  const conteudo = fs.existsSync(path.join(nova, 'config.json'))
    ? fs.readFileSync(path.join(nova, 'config.json'), 'utf8') : null;
  const antigaIntacta = fs.existsSync(path.join(antiga, 'config.json'));
  fs.rmSync(raiz, { recursive: true, force: true });
  console.log(`  ${nome.padEnd(34)} migrado=${String(r.migrado).padEnd(5)} motivo=${r.motivo.padEnd(18)} destino=${conteudo ? 'tem' : 'vazio'} origem_intacta=${antigaIntacta}`);
  return { r, conteudo, antigaIntacta };
}

const CFG = JSON.stringify({ api: 'https://api-hub.magazinedopovo.com.br', login: 'luana.gabriele', idfilial: 10001 });

let x = cenario('config antiga existe', ({ antiga }) => {
  fs.mkdirSync(antiga, { recursive: true });
  fs.writeFileSync(path.join(antiga, 'config.json'), CFG);
});
assert.strictEqual(x.r.migrado, true, 'devia migrar');
assert.strictEqual(x.conteudo, CFG, 'conteudo devia ser identico');
assert.ok(x.antigaIntacta, 'COPIA, nao move: a origem tem de continuar la');

x = cenario('ja migrou antes (destino existe)', ({ antiga, nova }) => {
  fs.mkdirSync(antiga, { recursive: true }); fs.mkdirSync(nova, { recursive: true });
  fs.writeFileSync(path.join(antiga, 'config.json'), CFG);
  fs.writeFileSync(path.join(nova, 'config.json'), '{"api":"ja-configurado"}');
});
assert.strictEqual(x.r.migrado, false);
assert.strictEqual(x.conteudo, '{"api":"ja-configurado"}', 'NAO pode sobrescrever o que ja existe');

x = cenario('instalacao nova (sem antiga)', () => {});
assert.strictEqual(x.r.migrado, false);
assert.strictEqual(x.conteudo, null);

x = cenario('config antiga corrompida', ({ antiga }) => {
  fs.mkdirSync(antiga, { recursive: true });
  fs.writeFileSync(path.join(antiga, 'config.json'), 'isto nao e json {{{');
});
assert.strictEqual(x.r.migrado, false, 'json quebrado nao pode migrar');
assert.ok(x.r.motivo.startsWith('erro:'), 'devia reportar o erro, nao estourar');

console.log('\n  OK — 4 cenarios');
