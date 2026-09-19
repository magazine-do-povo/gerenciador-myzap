/**
 * Identidade própria: leva a configuração da pasta antiga para a nova.
 *
 * ⚠️ **Por que o app precisou de identidade própria** (17/09/2026). Este projeto nasceu de
 * um clone do gerenciador da JZTech e ficou com a identidade DELE:
 *
 * | | antes | agora |
 * |---|---|---|
 * | `appId` | `com.jvtech.myzap` (igual ao da JZTech) | `com.magazinedopovo.myzap` |
 * | `name` | `gerenciador-myzap` (igual) | `gerenciador-myzap-mdp` |
 *
 * Com o mesmo `appId`, o instalador do Windows trata os dois como **o mesmo produto** e um
 * instala por cima do outro; com o mesmo `name`, `new Store()` grava no **mesmo
 * `config.json`** (`%APPDATA%\<name>\config.json`). Foi assim que uma loja do Magazine
 * amanheceu rodando o app da JZTech v2.3.9 — que pede "Código da empresa + token" em vez
 * do login e senha do Hub, e ainda abriu com os dados da configuração antiga preenchidos.
 *
 * Esta migração copia o `config.json` da pasta antiga para a nova na primeira abertura,
 * para que ninguém precise reconfigurar URL, login e senha.
 *
 * ⚠️ **COPIA, não move.** A pasta antiga pode estar em uso pelo app da JZTech na mesma
 * máquina — mover deixaria aquele app sem configuração.
 *
 * ⚠️ **Roda ANTES de qualquer `new Store()`.** Vários módulos do core instanciam o Store no
 * topo do arquivo; se o primeiro `require` acontecer antes desta cópia, o Store cria um
 * `config.json` vazio na pasta nova e a migração deixa de acontecer (a regra abaixo só
 * copia quando o destino NÃO existe).
 */

const fs = require('fs');
const path = require('path');

const PASTA_ANTIGA = 'gerenciador-myzap';
const ARQUIVO = 'config.json';

/**
 * @param {{ getPath: (nome: string) => string }} app o `app` do Electron
 * @returns {{ migrado: boolean, motivo: string, de?: string, para?: string }}
 */
function migrarConfiguracaoDaIdentidadeAntiga(app) {
    let destinoDir;
    try {
        destinoDir = app.getPath('userData');
    } catch (e) {
        return { migrado: false, motivo: 'sem_userdata' };
    }

    if (path.basename(destinoDir) === PASTA_ANTIGA) {
        // Ainda somos o app antigo (nome não mudou): não há o que migrar.
        return { migrado: false, motivo: 'mesma_pasta' };
    }

    const destino = path.join(destinoDir, ARQUIVO);
    const origem = path.join(path.dirname(destinoDir), PASTA_ANTIGA, ARQUIVO);

    try {
        if (fs.existsSync(destino)) {
            return { migrado: false, motivo: 'destino_ja_existe' };
        }
        if (!fs.existsSync(origem)) {
            return { migrado: false, motivo: 'origem_nao_existe' };
        }

        // Só migra configuração DESTE app: o config da JZTech tem idempresa/apitoken e não
        // tem login — copiá-lo traria lixo que a tela daqui nem sabe ler.
        const bruto = fs.readFileSync(origem, 'utf8');
        const dados = JSON.parse(bruto);
        if (!dados || typeof dados !== 'object') {
            return { migrado: false, motivo: 'origem_invalida' };
        }

        fs.mkdirSync(destinoDir, { recursive: true });
        fs.writeFileSync(destino, bruto, 'utf8');

        return { migrado: true, motivo: 'ok', de: origem, para: destino };
    } catch (e) {
        // Falhar aqui NÃO pode impedir o app de abrir: no pior caso a loja reconfigura.
        return { migrado: false, motivo: 'erro:' + (e && e.message ? e.message : 'desconhecido') };
    }
}

module.exports = { migrarConfiguracaoDaIdentidadeAntiga, PASTA_ANTIGA };
