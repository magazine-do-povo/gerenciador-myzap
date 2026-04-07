function setStatus(type, message) {
  const statusEl = document.getElementById('manual-status');
  if (!statusEl) return;

  statusEl.classList.remove('alert-info', 'alert-success', 'alert-danger', 'alert-warning');
  statusEl.classList.add(
    type === 'success' ? 'alert-success'
      : type === 'error' ? 'alert-danger'
        : type === 'warning' ? 'alert-warning'
          : 'alert-info'
  );
  statusEl.textContent = message || '';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value || '-';
  }
}

function setTextarea(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.value = value || '';
  }
}

function setButtonLoading(button, loading, textLoading, textIdle) {
  if (!button) return;
  button.disabled = loading;
  button.textContent = loading ? textLoading : textIdle;
}

async function runAction(button, textLoading, textIdle, action) {
  setButtonLoading(button, true, textLoading, textIdle);
  try {
    const result = await action();
    if (result?.status === 'error') {
      setStatus('error', result.message || 'Falha ao executar a acao.');
      return;
    }

    setStatus('success', result?.message || 'Acao executada com sucesso.');
  } catch (err) {
    setStatus('error', `Falha ao executar a acao: ${err?.message || err}`);
  } finally {
    setButtonLoading(button, false, textLoading, textIdle);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const result = await window.api.getManualSetupInfo();
    if (!result || result.status === 'error') {
      setStatus('error', result?.message || 'Nao foi possivel carregar a ajuda manual.');
      return;
    }

    const info = result.data || {};
    setText('target-dir', info.targetDir);
    setText('guide-path', info.guideFilePath);
    setText('node-url', info.nodeDownloadUrl);
    setText('git-url', info.gitDownloadUrl);
    setTextarea('clone-commands', info.cloneCommands);
    setTextarea('update-commands', info.updateCommands);
    setText('next-step-hint', info.nextStepHint);
    setStatus('info', 'Use esta janela como rota manual de suporte quando a automacao demorar mais que o esperado.');

    const btnOpenGuide = document.getElementById('btn-open-guide');
    const btnOpenFolder = document.getElementById('btn-open-folder');
    const btnOpenNode = document.getElementById('btn-open-node');
    const btnOpenGit = document.getElementById('btn-open-git');
    const btnOpenRepo = document.getElementById('btn-open-repo');

    btnOpenGuide?.addEventListener('click', () => runAction(
      btnOpenGuide,
      'Abrindo TXT...',
      'Abrir arquivo TXT',
      () => window.api.openManualSetupGuide()
    ));

    btnOpenFolder?.addEventListener('click', () => runAction(
      btnOpenFolder,
      'Abrindo pasta...',
      'Abrir pasta do MyZap',
      () => window.api.openManualSetupTargetDirectory()
    ));

    btnOpenNode?.addEventListener('click', () => runAction(
      btnOpenNode,
      'Abrindo link...',
      'Baixar Node.js',
      () => window.api.openManualSetupLink('node')
    ));

    btnOpenGit?.addEventListener('click', () => runAction(
      btnOpenGit,
      'Abrindo link...',
      'Baixar Git',
      () => window.api.openManualSetupLink('git')
    ));

    btnOpenRepo?.addEventListener('click', () => runAction(
      btnOpenRepo,
      'Abrindo repositorio...',
      'Abrir repositorio MyZap',
      () => window.api.openManualSetupLink('repo')
    ));
  } catch (err) {
    setStatus('error', `Erro ao carregar a ajuda manual: ${err?.message || err}`);
  }
});
