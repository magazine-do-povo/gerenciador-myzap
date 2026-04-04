(async () => {
  try {
    document.getElementById('api').value = (await window.api.getStore('apiUrl')) ?? '';
    document.getElementById('login').value = (await window.api.getStore('apiLogin')) ?? '';
    document.getElementById('password').value = (await window.api.getStore('apiPassword')) ?? '';
    document.getElementById('idfilial').value = (await window.api.getStore('idfilial')) ?? (await window.api.getStore('idempresa')) ?? '';
  } catch (e) {
    alert('Erro ao carregar configuracoes: ' + (e?.message || e));
  }
})();

const cfg = document.getElementById('cfg');

cfg.onsubmit = (e) => {
  e.preventDefault();

  const apiUrl = document.getElementById('api').value.trim();
  const apiLogin = document.getElementById('login').value.trim();
  const apiPassword = document.getElementById('password').value;

  if (!apiUrl.startsWith('http')) {
    alert('URL da API invalida');
    return;
  }

  if (!apiLogin) {
    alert('Informe o usuario do Hub');
    return;
  }

  if (!apiPassword) {
    alert('Informe a senha do Hub');
    return;
  }

  window.api.send('settings-saved', {
    apiUrl,
    apiLogin,
    apiPassword
  });

  alert('Configuracoes salvas!');
  window.close();
};
