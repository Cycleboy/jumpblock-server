// Servidor online de JumpBlock.
// Solo hace de puente: arma salas con un código de 4 letras y pasa los mensajes
// entre el anfitrión (que calcula la partida) y los demás jugadores de la sala.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin letras que se confunden (I, O, 0, 1)

const rooms = new Map();   // código → { code, peers: Map(id → socket), started }

// Página simple para comprobar que el servidor anda (y para que el hosting lo vea vivo)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Servidor de JumpBlock funcionando. Salas abiertas: ${rooms.size}`);
});
const wss = new WebSocketServer({ server });

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // crear una sala nueva: el que la crea es el anfitrión (jugador 0)
    if (msg.t === 'create') {
      if (ws.room) return;
      const room = { code: newCode(), peers: new Map([[0, ws]]), started: false };
      rooms.set(room.code, room);
      ws.room = room;
      ws.id = 0;
      send(ws, { t: 'created', code: room.code, id: 0 });
      return;
    }

    // unirse a una sala con su código
    if (msg.t === 'join') {
      if (ws.room) return;
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room) return send(ws, { t: 'error', msg: 'No existe una sala con ese código.' });
      if (room.started) return send(ws, { t: 'error', msg: 'La partida ya empezó. Esperá a que termine y probá de nuevo.' });
      let id = 1;
      while (room.peers.has(id) && id < MAX_PLAYERS) id++;
      if (room.peers.has(id) || id >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'La sala está llena (máximo 4 jugadores).' });
      room.peers.set(id, ws);
      ws.room = room;
      ws.id = id;
      send(ws, { t: 'joined', code: room.code, id });
      send(room.peers.get(0), { t: 'peer-join', id });
      return;
    }

    const room = ws.room;
    if (!room) return;
    if (ws.id === 0) {
      // anfitrión → todos los demás (estado de la partida, etc.)
      if (msg.t === 'started') { room.started = !!msg.v; return; }
      const raw = JSON.stringify(msg);
      for (const [id, peer] of room.peers) if (id !== 0 && peer.readyState === peer.OPEN) peer.send(raw);
    } else {
      // jugador → anfitrión (sus teclas), marcado con su número
      msg.id = ws.id;
      send(room.peers.get(0), msg);
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (ws.id === 0) {
      // se fue el anfitrión: se cierra la sala
      for (const [id, peer] of room.peers) {
        if (id === 0) continue;
        send(peer, { t: 'host-left' });
        peer.room = null;
      }
      rooms.delete(room.code);
    } else {
      room.peers.delete(ws.id);
      send(room.peers.get(0), { t: 'peer-leave', id: ws.id });
    }
  });
});

// Cada 30 s se comprueba que las conexiones sigan vivas (y se cierran las colgadas)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Servidor de JumpBlock escuchando en el puerto ${PORT}`));
