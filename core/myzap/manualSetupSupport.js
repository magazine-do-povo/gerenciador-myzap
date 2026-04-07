const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDefaultMyZapDirectory } = require('./autoConfig');

const MYZAP_REPO_WEB_URL = 'https://github.com/JZ-TECH-SYS/myzap';
const MYZAP_REPO_CLONE_URL = 'https://github.com/JZ-TECH-SYS/myzap.git';
const GUIDE_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'docs', 'AJUDA_CONFIGURACAO_MANUAL_MYZAP.txt');

const NODE_DOWNLOAD_URLS = {
    win32: 'https://nodejs.org/en/download',
    darwin: 'https://nodejs.org/en/download',
    linux: 'https://nodejs.org/en/download/package-manager'
};

const GIT_DOWNLOAD_URLS = {
    win32: 'https://git-scm.com/download/win',
    darwin: 'https://git-scm.com/download/mac',
    linux: 'https://git-scm.com/download/linux'
};

function getSupportDirectory() {
    const home = os.homedir();

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return path.join(localAppData, 'gerenciador-myzap', 'suporte');
    }

    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'gerenciador-myzap', 'suporte');
    }

    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    return path.join(xdgDataHome, 'gerenciador-myzap', 'suporte');
}

function getPlatformLabel() {
    if (process.platform === 'win32') return 'Windows';
    if (process.platform === 'darwin') return 'macOS';
    return 'Linux';
}

function buildCommandBlock(lines) {
    return lines.join(os.EOL);
}

function getCommandPrefix(directoryPath) {
    return process.platform === 'win32'
        ? `cd /d "${directoryPath}"`
        : `cd "${directoryPath}"`;
}

function getManualSetupInfo() {
    const targetDir = getDefaultMyZapDirectory();
    const parentDir = path.dirname(targetDir);
    const targetDirName = path.basename(targetDir);
    const supportDir = getSupportDirectory();
    const guideFilePath = path.join(supportDir, 'AJUDA-CONFIGURACAO-MANUAL-MYZAP.txt');

    const cloneCommands = buildCommandBlock([
        getCommandPrefix(parentDir),
        `git clone --depth 1 --branch main ${MYZAP_REPO_CLONE_URL} "${targetDirName}"`
    ]);

    const updateCommands = buildCommandBlock([
        getCommandPrefix(targetDir),
        'git pull origin main'
    ]);

    return {
        platform: process.platform,
        platformLabel: getPlatformLabel(),
        nodeDownloadUrl: NODE_DOWNLOAD_URLS[process.platform] || NODE_DOWNLOAD_URLS.win32,
        gitDownloadUrl: GIT_DOWNLOAD_URLS[process.platform] || GIT_DOWNLOAD_URLS.win32,
        repoWebUrl: MYZAP_REPO_WEB_URL,
        repoCloneUrl: MYZAP_REPO_CLONE_URL,
        targetDir,
        parentDir,
        targetDirName,
        supportDir,
        guideFilePath,
        cloneCommands,
        updateCommands,
        nextStepHint: 'Depois da preparacao manual, volte ao Painel MyZap e clique em Instalar Novamente.'
    };
}

function getFallbackGuideTemplate() {
    return [
        'AJUDA DE CONFIGURACAO MANUAL DO MYZAP',
        '',
        '1. Instalar Node.js',
        '{{NODE_DOWNLOAD_URL}}',
        '',
        '2. Instalar Git',
        '{{GIT_DOWNLOAD_URL}}',
        '',
        '3. Pasta do MyZap',
        '{{TARGET_DIR}}',
        '',
        '4. Clonar repositorio',
        '{{CLONE_COMMAND}}',
        '',
        '5. Atualizacao manual opcional',
        '{{UPDATE_COMMAND}}',
        '',
        '6. Depois volte ao painel do Gerenciador MyZap e clique em Instalar Novamente.'
    ].join(os.EOL);
}

function renderGuideTemplate(template, info) {
    return String(template || '')
        .replaceAll('{{NODE_DOWNLOAD_URL}}', info.nodeDownloadUrl)
        .replaceAll('{{GIT_DOWNLOAD_URL}}', info.gitDownloadUrl)
        .replaceAll('{{TARGET_DIR}}', info.targetDir)
        .replaceAll('{{REPO_WEB_URL}}', info.repoWebUrl)
        .replaceAll('{{CLONE_COMMAND}}', info.cloneCommands)
        .replaceAll('{{UPDATE_COMMAND}}', info.updateCommands)
        .replaceAll('{{PLATFORM_LABEL}}', info.platformLabel);
}

function ensureManualSetupGuideFile() {
    const info = getManualSetupInfo();
    let template = getFallbackGuideTemplate();

    try {
        if (fs.existsSync(GUIDE_TEMPLATE_PATH)) {
            template = fs.readFileSync(GUIDE_TEMPLATE_PATH, 'utf8');
        }
    } catch (_err) {
        template = getFallbackGuideTemplate();
    }

    fs.mkdirSync(info.supportDir, { recursive: true });
    fs.writeFileSync(info.guideFilePath, renderGuideTemplate(template, info), 'utf8');
    return info;
}

module.exports = {
    MYZAP_REPO_WEB_URL,
    MYZAP_REPO_CLONE_URL,
    getManualSetupInfo,
    ensureManualSetupGuideFile
};
