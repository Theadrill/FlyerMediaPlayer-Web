# FlyerMediaPlayer Web — Plano de Implementação

## Visão Geral

Portar o app Android `FlyerMediaPlayer` (Digital Signage para Android TV) para uma
solução web que roda como **fonte HTML no OBS Studio** (via plugin de navegador).
O player escaneia um pendrive, encontra o vídeo com "MAIN" no nome na raiz,
cataloga os vídeos da pasta `VIDEOS` e executa o fluxo:

**1 MAIN (completo) → 2 aleatórios (máx 8min cada) → repete**

Além disso, oferece um painel de controle de cenas do OBS acessível remotamente
via celular.

---

## Arquitetura

```
[Pendrive E:, F:, ...]          [Node.js Server :4600]          [OBS Studio]
       |                               |                              |
       |  (leitura direta)             |  (Express + WebSocket)       |
+--- D:\VIDEOS\*.mp4 ---------->+                              |
        +--- D:\MAIN*.mp4 ------------>+                              |
                                       |                              |
                                       +--- HTTP localhost:4600 ----->+  Browser Source (player)
                                       |                              |
                                       +--- HTTP :4600/cenas -------->+  Dock / Celular (controle)
                                       |                              |
                                       +--- WebSocket :4455 --------->+  OBS WebSocket Server
```

| Camada | Tecnologia |
|--------|-----------|
| Servidor HTTP | Node.js + Express |
| Controle OBS | `obs-websocket-js` (conexão ao WebSocket do OBS) |
| Player | HTML5 `<video>` com JavaScript vanilla |
| Painel Cenas | HTML/CSS/JS vanilla, mobile-first |

---

## Decisões de Projeto

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Framework | Express | Maturidade, ecossistema, simplicidade p/ projeto pequeno |
| Porta | 4600 | Definido pelo usuário |
| Drive C: e D: | Ignorados | C: = sistema, D: = CD-ROM |
| Extensão vídeo | `.mp4` apenas | Compatibilidade com navegador/CEF |
| Autoplay | Automático ao carregar | OBS "Refresh browser when scene becomes active" |
| Corte aleatório | 8 minutos (setTimeout no JS) | Mesma lógica do app Android |
| OBS WebSocket | Server-side (`obs-websocket-js`) | Centraliza autenticação, evita CORS |

---

## Estrutura do Projeto

```
C:\PROJETOS\FlyerMediaPlayer-Web\
├── .env                       # Config (senha OBS, porta)
├── .env.example               # Template sem secrets
├── .gitignore
├── package.json
├── server.js                  # Servidor Express + OBS WS client
└── public\
    ├── index.html             # Player fullscreen (auto-start)
    ├── style.css              # Estilos globais
    ├── script.js              # Lógica do player (playlist engine)
    └── cenas.html             # Painel de cenas (mobile-first)
```

---

## Especificação do Servidor (`server.js`)

### Endpoints

| Método | Rota | Descrição | Resposta |
|--------|------|-----------|----------|
| GET | `/` | Página do player | `index.html` |
| GET | `/cenas` | Painel de controle de cenas | `cenas.html` |
| GET | `/api/scan` | Escaneia drives e retorna vídeos | `{status, main[], random[], drive}` |
| GET | `/api/video?path=...` | Stream de vídeo com range requests | `video/mp4` (stream) |
| GET | `/api/obs/scenes` | Lista cenas do OBS | `{scenes[], activeScene, connected}` |
| POST | `/api/obs/switch-scene` | Troca para cena específica | `{success}` |

### Lógica de Scan de Drives

```
1. Lista drives A:-Z: via `wmic logicaldisk get caption`
2. Filtra: remove C:, D:
3. Para cada drive restante (em ordem alfabética):
   a. Verifica se existe na raiz arquivo .mp4 contendo "MAIN" no nome
   b. Se sim → este é o drive do pendrive
   c. Procura pasta VIDEOS (ou videos) na raiz
   d. Lista todos os .mp4 dentro (apenas raiz da pasta, sem subpastas)
   e. Retorna { main[], random[], drive }
4. Se nenhum drive com MAIN encontrado → { status: "waiting" }
```

### Video Streaming com Range Requests

Essencial para o `<video>` do HTML5 funcionar com seek e barra de progresso:

```
GET /api/video?path=E:\VIDEOS\video.mp4
  Headers:
    - Content-Type: video/mp4
    - Accept-Ranges: bytes
    - Content-Range: bytes 0-1000/100000 (se range header presente)
    - Content-Length: ...
  Body: stream do arquivo via fs.createReadStream()
```

### OBS WebSocket

- Conecta ao `obs-websocket-js` na porta 4455 (configurável)
- Usa senha do `.env`
- Auto-reconnect com backoff exponencial
- Mantém cache das scenes (atualizado via eventos `SceneListChanged`,
  `CurrentProgramSceneChanged`)
- Se desconectado, `/api/obs/scenes` retorna `{ connected: false }`

---

## Especificação do Player (`index.html` + `script.js`)

### Comportamento

```
Pagina carrega
  └─ autoScan()
       ├─ /api/scan → {status:"waiting"}
       │    └─ esconde video, mostra "Aguardando Pen Drive"
       │    └─ setTimeout(autoScan, 2000)
       │
       └─ /api/scan → {status:"found", main, random, drive}
            └─ esconde status, mostra video
            └─ buildQueues()
            └─ playMain()

playMain():
  se filaMain vazia → shuffle(listaMain)
  video.src = /api/video?path=mainQueue.shift()
  video.play()
  no ended → playRandom()

playRandom():
  videosAleatoriosTocados++
  se filaRandom vazia → shuffle(listaRandom)
  video.src = /api/video?path=randomQueue.shift()
  video.play()
  setTimeout(forcarProximo, 480000)  # 8 minutos
  no ended → limpa setTimeout → decide()

decide():
  se videosAleatoriosTocados >= 2 → playMain()
  senao → playRandom()

forcarProximo():
  limpa setTimeout
  decide()

onVideoError → autoScan()  # Pen drive removido
```

### Teclas de Atalho

| Tecla | Ação |
|-------|------|
| Seta Direita | Pula para o próximo vídeo |
| Space | Pula para o próximo vídeo |
| N | Próximo (quando `/cenas` aberto) |

### Interface

- **Fullscreen** (1920x1080), fundo preto
- `<video>` ocupa 100% da tela, `object-fit: contain`
- Overlay "Aguardando Pen Drive" centralizado quando sem drive
- Barra de progresso horizontal fina no canto inferior:
  - Vídeos MAIN: barra até o fim do vídeo
  - Vídeos aleatórios: barra vai até 8 minutos
- Sem botões visíveis (auto-start)

---

## Especificação do Painel de Cenas (`cenas.html`)

### Comportamento

- Mobile-first, responsivo
- Mostra status da conexão OBS no topo
- Lista vertical de cenas com botões grandes (touch target ≥ 48px)
- Cena ativa destacada com cor diferente
- Ao clicar: `POST /api/obs/switch-scene` com feedback visual
- Auto-refresh a cada 3s (polling `/api/obs/scenes`)
- Atalho de teclado: números 1-9 para cenas

### Layout

```
┌─────────────────────────┐
│ ● Conectado ao OBS      │
│                         │
│ ┌─────────────────────┐ │
│ │ Futebol             │ │  ← cena ativa (cor diferente)
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ Intervalo           │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ Placar              │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ Propaganda          │ │
│ └─────────────────────┘ │
└─────────────────────────┘
```

---

## Configuração

### `.env`

```
PORT=4600
OBS_WS_HOST=127.0.0.1
OBS_WS_PORT=4455
OBS_WS_PASSWORD=minha_senha_aqui
```

### OBS Studio

1. **Ferramentas → WebSocket Server Settings**
   - Habilitar servidor WebSocket
   - Porta: 4455
   - Senha: (igual ao .env)

2. **Browser Source (Player)**
   - URL: `http://localhost:4600`
   - Largura: 1920, Altura: 1080
   - ✅ Refresh browser when scene becomes active

3. **Custom Browser Dock (Cenas) — opcional**
   - Exibir → Docks → Custom Browser Docks
   - URL: `http://localhost:4600/cenas`
   - Nome: "Flyer Media"

### Acesso Remoto

No celular/tablet, abrir:

```
http://<IP-DO-PC>:4600/cenas
```

Exemplo: `http://192.168.1.100:4600/cenas`

---

## Casos de Borda

| Situação | Comportamento |
|----------|---------------|
| Pen drive removido durante playback | Erro no `<video>` → `autoScan()` → modo "Aguardando" |
| Pen drive reconectado | Polling 2s detecta → escaneia → inicia playback |
| Nenhum MAIN encontrado | Mostra "Nenhum vídeo MAIN encontrado" |
| Pasta VIDEOS vazia | Só toca MAIN em loop |
| OBS WebSocket offline | `/cenas` mostra "Desconectado" |
| OBS fecha/reinicia | Auto-reconnect do WebSocket |
| Vários drives com MAIN | Usa o primeiro encontrado (ordem alfabética E:, F:, ...) |

---

## Dependências

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.4.5",
    "obs-websocket-js": "^5.0.5"
  }
}
```

---

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Configurar .env (copiar .env.example e editar)
cp .env.example .env

# 3. Configurar OBS WebSocket com a mesma senha

# 4. Iniciar servidor
node server.js

# 5. Adicionar Browser Source no OBS apontando para:
#    http://localhost:4600
```
