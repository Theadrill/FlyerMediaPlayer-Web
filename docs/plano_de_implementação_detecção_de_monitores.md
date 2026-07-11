# Plano: Detecção de Monitores + Fullscreen Automático

## Problema

O DJ conecta/desconecta o HDMI do notebook frequentemente.
O player precisa automaticamente:
- Jogar em fullscreen na tela 2 quando disponível
- Entrar em modo de espera discreto quando o HDMI é removido
- Voltar a tocar quando o HDMI retorna

O navegador não permite detectar monitores ou posicionar janelas.
Solução: **Electron**.

---

## O que será removido

- Toda integração OBS WebSocket (`obs-websocket-js`)
- Endpoints `/api/obs/scenes` e `/api/obs/switch-scene`
- Arquivo `public/cenas.html`
- Variáveis `OBS_WS_*` do `.env`

---

## O que será adicionado

### Dependência

```
electron (devDependency)
```

### Novo arquivo: `electron-main.js`

Entry point do Electron. Responsabilidades:

1. **Express server em background** - Mantém o `server.js` atual rodando na porta 4600
2. **Janela de espera** - 300x100px, centralizada, fundo escuro, texto "Aguardando segundo monitor"
3. **Janela fullscreen** - Criada no segundo monitor quando detectado
4. **Escuta eventos do sistema:**
   - `screen.on('display-added')` → verifica se há 2+ displays → cria/joga janela fullscreen na tela 2
   - `screen.on('display-removed')` → esconde janela fullscreen, mostra janela de espera

#### Lógica de detecção

```
App inicia
  → Express server sobe (porta 4600)
  → screen.getAllDisplays()
  → Se 1 display: cria janela de espera (300x100px)
  → Se 2+ displays: cria janela fullscreen no display secundário

display-added (HDMI conectado):
  → Fecha janela de espera
  → Cria BrowserWindow fullscreen no display[1]
  → Carrega http://localhost:4600

display-removed (HDMI desconectado):
  → Fecha/esconde janela fullscreen
  → Recria janela de espera na tela 1
```

#### Janela de espera

```js
{
  width: 300,
  height: 100,
  frame: false,          // Sem barra de título
  alwaysOnTop: true,     // Sempre visível
  resizable: false,
  skipTaskbar: true,
  center: true,
  webPreferences: {
    nodeIntegration: false
  }
}
```

Conteúdo: HTML inline com fundo `#111`, texto branco "Aguardando segundo monitor".

#### Janela fullscreen (player)

```js
{
  fullscreen: true,
  kiosk: true,           // Modo kiosk (sem possibilidade de sair)
  skipTaskbar: true,
  webPreferences: {
    nodeIntegration: false
  }
}
```

- Posicionada no `display[1]` via `bounds.x` / `bounds.y`
- Carrega `http://localhost:4600`
- Tecla Escape desativa fullscreen (para emergências)

---

## Alterações em arquivos existentes

### `package.json`

```json
{
  "main": "electron-main.js",
  "scripts": {
    "start": "node server.js",
    "electron": "electron ."
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```

### `server.js`

Remover:
- `const OBSWebSocket = require('obs-websocket-js').default;`
- Toda a seção "OBS WebSocket Client" (linhas 18-75)
- Endpoint `GET /api/obs/scenes`
- Endpoint `POST /api/obs/switch-scene`
- Rota `GET /cenas`
- `connectOBS()` no `app.listen`

### `public/cenas.html`

Remover completamente.

### `.env.example`

Remover variáveis:
```
OBS_WS_HOST
OBS_WS_PORT
OBS_WS_PASSWORD
```

Manter apenas:
```
PORT=4600
```

---

## Arquivos NÃO modificados

- `public/index.html`
- `public/script.js` - Toda lógica de playlist intacta
- `public/style.css` - Estilos do player sem alteração

---

## Novo arquivo: `start.bat`

Batch de execução rápida para uso enquanto não há `.exe`:

```bat
@echo off
echo Iniciando FlyerMediaPlayer...
echo.
cd /d "%~dp0"
npx electron .
pause
```

- `cd /d "%~dp0"` garante que entra no diretório do projeto
- `npx electron .` roda sem precisar instalar electron globalmente
- `pause` mantém a janela do CMD aberta para ver erros

---

## Como rodar

```bash
# Modo navegador (testes, sem detecção de monitor)
npm start

# Modo Electron (produção, com detecção automática)
npm run electron

# Modo rápido (duplo clique no arquivo)
start.bat
```

---

## Fluxo visual

```
┌─────────────────────────────────────────────────┐
│  TELA 1 (notebook)                               │
│                                                  │
│  ┌──────────────────────┐                        │
│  │ Aguardando segundo   │  ← Janela de espera    │
│  │ monitor              │     (300x100px)         │
│  └──────────────────────┘                        │
│                                                  │
└─────────────────────────────────────────────────┘

          HDMI conectado →

┌─────────────────────────────────────────────────┐
│  TELA 2 (TV/projetor externo)                    │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │                                             │ │
│  │           [PLAYER EM FULLSCREEN]            │ │
│  │                                             │ │
│  │    MAIN VIDEO → random → random → MAIN    │ │
│  │                                             │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## Resumo de arquivos

| Arquivo | Ação |
|---------|------|
| `electron-main.js` | **Criar** - Entry point do Electron |
| `start.bat` | **Criar** - Execução rápida |
| `package.json` | **Modificar** - Adicionar electron e scripts |
| `server.js` | **Modificar** - Remover lógica OBS |
| `.env.example` | **Modificar** - Remover variáveis OBS |
| `public/cenas.html` | **Remover** |
| `docs/plano_de_implementação_detecção_de_monitores.md` | **Criar** - Este documento |
