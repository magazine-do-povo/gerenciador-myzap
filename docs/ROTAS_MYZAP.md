# Contrato Atual Do Hub Para O Gerenciador MyZap

Documento atualizado a partir da implementacao real do Hub da Magazine do Povo:

- routes: `api/src/routes.php`
- login: `api/src/controllers/LoginController.php` e `api/src/handlers/LoginHandler.php`
- myzap: `api/src/controllers/MyzapController.php` e `api/src/handlers/MyzapHandler.php`

## 1. Regras gerais

- Base principal: `apiUrl` salva nas configuracoes do app.
- Autenticacao: `POST /login` com `login` e `senha`.
- O retorno do login vem encapsulado em `result` e o Hub sempre responde JSON no formato:

```json
{
  "result": {},
  "error": false
}
```

- O JWT expira em `3600` segundos e o payload contem `idfilial`.
- O gerenciador deve tratar `idfilial` como identificador principal da integracao.

## 2. Autenticacao

Endpoint real:

- `POST /login`

Body esperado:

```json
{
  "login": "usuario",
  "senha": "senha"
}
```

Resposta real do handler:

```json
{
  "result": {
    "token": "Bearer <jwt>",
    "expires_in": 3600,
    "ip": "172.18.0.1",
    "usuario": {
      "idusuario": 584,
      "nome": null,
      "login": "joaosn",
      "idcnpj_cpf": null,
      "cnpj_cpf": null,
      "idgrupo": 1,
      "idfilial": 10001
    }
  },
  "error": false
}
```

Campos relevantes para o gerenciador:

- `result.token`: header Authorization completo no formato `Bearer ...`.
- `result.expires_in`: TTL em segundos.
- `result.usuario.idfilial`: filial usada nas rotas do MyZap.

## 3. Endpoints reais do modulo MyZap no Hub

Rotas declaradas hoje:

- `GET /myzap/config/{idfilial}`
- `PUT /myzap/config/{idfilial}`
- `GET /myzap/status/{idfilial}`
- `GET /myzap/qrcode/{idfilial}`
- `GET /myzap/logout/{idfilial}`
- `POST /myzap/send-text`
- `GET /myzap/fila/{idfilial}`
- `GET /myzap/dashboard/{idfilial}`
- `GET /myzap/pendentes`
- `POST /myzap/fila/status`
- `PUT /myzap/status`
- `GET /parametrizacao-myzap/config/{idfilial}`
- `GET /parametrizacao-myzap/configuracao/{idfilial}`
- `GET /parametrizacao-myzap/pendentes`
- `POST /parametrizacao-myzap/fila/status`
- `PUT /parametrizacao-myzap/status`

Observacao importante:

- Nao existe rota `POST /parametrizacao-myzap/tokens/sync` declarada em `routes.php`.

## 4. Configuracao remota do MyZap

Rotas reais que retornam configuracao:

1. `GET /myzap/config/{idfilial}`
2. `GET /parametrizacao-myzap/config/{idfilial}`
3. `GET /parametrizacao-myzap/configuracao/{idfilial}`

O handler `MyzapHandler::getConfig` devolve um objeto com estes campos:

```json
{
  "result": {
    "idfilial": 10001,
    "idempresa": 10001,
    "session_myzap": "sessao_filial",
    "key_myzap": "token_local_myzap",
    "modo_myzap": 2,
    "modo_label": "Local",
    "status_myzap": "pendente",
    "data_ult_verificacao": null,
    "created_at": null,
    "updated_at": null,
    "fila_total": 0,
    "fila_pendente": 0,
    "fila_erro": 0
  },
  "error": false
}
```

Mapeamento usado pelo gerenciador:

- `session_myzap` -> `sessionKey`
- `key_myzap` -> `myzapApiToken`
- `modo_myzap` -> modo de integracao
- `idfilial` -> identificador principal da filial

Normalizacao de modo no app:

- `1` -> `web`
- `2` -> `local`

## 5. Polling da fila

Endpoint real:

- `GET /parametrizacao-myzap/pendentes`

Parametro realmente lido pelo controller:

- `sessionKey`

Implementacao do Hub:

```php
$sessionKey = (string) ($_GET['sessionKey'] ?? ($_GET['sessionkey'] ?? ''));
```

O controller nao usa `sessionToken` nem `idempresa` nessa busca.

Resposta normalizada pelo handler:

```json
{
  "result": {
    "total": 1,
    "mensagens": [
      {
        "idfila": 987,
        "idfilial": 10001,
        "idempresa": 10001,
        "sessionkey": "sessao_filial",
        "apitoken": "token_local_myzap",
        "json": "{\"endpoint\":\"sendText\",\"data\":{...}}",
        "status": "pendente"
      }
    ]
  },
  "error": false
}
```

## 6. Callback de status da fila

Endpoint real:

- `POST /parametrizacao-myzap/fila/status`

Body realmente esperado pelo controller:

```json
{
  "idfila": 987,
  "idfilial": 10001,
  "status": "enviado"
}
```

Compatibilidade legada ainda aceita:

- `idempresa` no lugar de `idfilial`

Implementacao real:

```php
$idfilial = (int) ($data['idempresa'] ?? ($data['idfilial'] ?? 0));
```

## 7. Atualizacao passiva de status

Endpoint real:

- `PUT /parametrizacao-myzap/status`

Body aceito pelo handler:

```json
{
  "sessionKey": "sessao_filial",
  "sessionName": "sessao_filial",
  "status_myzap": "ativo",
  "data_ult_verificacao": "2026-04-03 14:30:00",
  "idfilial": 10001
}
```

Compatibilidade legada ainda aceita:

- `idempresa` no lugar de `idfilial`

## 8. Divergencias Encontradas Em Relacao Ao Legado

- O legado usava token fixo salvo manualmente; o Hub atual exige `POST /login` com `login` e `senha`.
- O legado buscava configuracao em varias rotas inexistentes hoje, incluindo variantes por query string com `idempresa`; o Hub atual declara apenas rotas por path com `idfilial`.
- O legado tratava `idempresa` como identificador principal; o Hub atual trabalha por `idfilial`, mantendo `idempresa` apenas como alias de compatibilidade em alguns handlers.
- O legado enviava `sessionToken` e `idempresa` no `GET /parametrizacao-myzap/pendentes`; o controller atual usa apenas `sessionKey`.
- O legado inferia sync de tokens de IA como disponivel; a rota `POST /parametrizacao-myzap/tokens/sync` nao aparece nas rotas reais atuais.

## 9. Checklist rapido de compatibilidade

- `POST /login` precisa retornar `result.token`, `result.expires_in` e `result.usuario.idfilial`.
- `GET /myzap/config/{idfilial}` ou um dos aliases de configuracao precisa retornar `session_myzap` e `key_myzap`.
- `GET /parametrizacao-myzap/pendentes` deve aceitar `sessionKey` e devolver `result.mensagens`.
- `POST /parametrizacao-myzap/fila/status` deve aceitar `idfila`, `idfilial` e `status`.
- `PUT /parametrizacao-myzap/status` deve aceitar `sessionKey`, `status_myzap`, `data_ult_verificacao` e `idfilial`.
