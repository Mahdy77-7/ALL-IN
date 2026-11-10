/**
 * Felt — Zero-Dependency Offline Poker Chips Companion Server
 * Deliverable 2: Pure Node.js HTTP + RFC 6455 Raw WebSocket Relay Server
 *
 * Usage (Laptop or Android Termux over Mobile Hotspot / Local Wi-Fi):
 *   node server.js
 *
 * Zero external npm packages required. Uses only built-in Node.js modules:
 *   node:http, node:fs, node:path, node:crypto, node:os, node:url
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRIMARY_PORT = Number(process.env.PORT) || 3000;
const SECONDARY_WS_PORT = 8080;
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Discover all local LAN / Hotspot IPv4 addresses on this machine
 */
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        results.push({ interface: name, address: addr.address });
      }
    }
  }
  if (results.length === 0) {
    results.push({ interface: 'loopback', address: '127.0.0.1' });
  }
  return results;
}

/**
 * Connected WebSocket clients and authoritative room snapshot cache
 */
const clients = new Map(); // socketId -> { id, socket, buffer, room, role, name, playerId, connectedAt }
const roomStates = new Map(); // roomCode -> { state, hostId, updatedAt }

/**
 * Encode a UTF-8 JSON string into an unmasked RFC 6455 WebSocket text frame
 */
function encodeWsTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + Text frame (0x1)
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Encode a control frame (Pong 0x8A or Close 0x88)
 */
function encodeWsControlFrame(opcode, payload = Buffer.alloc(0)) {
  const len = Math.min(payload.length, 125);
  const header = Buffer.from([0x80 | (opcode & 0x0f), len]);
  return Buffer.concat([header, payload.subarray(0, len)]);
}

/**
 * Safely write a text message to a single client
 */
function sendToClient(client, messageObj) {
  if (!client || !client.socket || client.socket.destroyed || !client.socket.writable) {
    return false;
  }
  try {
    const raw = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
    client.socket.write(encodeWsTextFrame(raw));
    return true;
  } catch {
    return false;
  }
}

/**
 * Broadcast a message to all clients in a room (optionally excluding sender)
 */
function broadcastRoom(roomCode, messageObj, excludeId = null) {
  const raw = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
  const frame = encodeWsTextFrame(raw);
  for (const client of clients.values()) {
    if (client.room === roomCode && client.id !== excludeId) {
      if (client.socket && !client.socket.destroyed && client.socket.writable) {
        try {
          client.socket.write(frame);
        } catch {
          // Ignore write errors on closing sockets
        }
      }
    }
  }
}

/**
 * Broadcast active presence roster to everyone in the room
 */
function broadcastPresence(roomCode) {
  const peers = [];
  for (const c of clients.values()) {
    if (c.room === roomCode) {
      peers.push({
        peerId: c.id,
        role: c.role,
        name: c.name,
        playerId: c.playerId,
        connectedAt: c.connectedAt
      });
    }
  }
  broadcastRoom(roomCode, {
    type: 'PRESENCE_UPDATE',
    room: roomCode,
    peers,
    timestamp: Date.now()
  });
}

/**
 * Process decoded JSON messages from any WebSocket peer
 */
function handleClientMessage(client, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  if (!msg || typeof msg !== 'object') return;

  const room = String(msg.room || client.room || 'MAIN').toUpperCase();
  client.room = room;

  switch (msg.type) {
    case 'HOST_REGISTER':
    case 'HELLO': {
      client.role = msg.role === 'host' || msg.type === 'HOST_REGISTER' ? 'host' : 'client';
      client.name = msg.name || (client.role === 'host' ? 'Host' : 'Player');
      client.playerId = msg.playerId || client.playerId || null;

      if (msg.state && client.role === 'host') {
        roomStates.set(room, {
          state: msg.state,
          hostId: client.id,
          updatedAt: Date.now()
        });
      }

      const cached = roomStates.get(room);
      sendToClient(client, {
        type: 'WELCOME',
        peerId: client.id,
        room,
        cachedState: cached ? cached.state : null
      });

      broadcastPresence(room);
      break;
    }

    case 'LOBBY_JOIN': {
      client.role = 'client';
      client.name = (msg.name || 'Player').trim().slice(0, 22) || 'Player';
      client.playerId = msg.playerId || ('wifi_' + client.id);

      // Relay to Host so Host adds player to lobby state
      broadcastRoom(
        room,
        {
          type: 'LOBBY_JOIN',
          peerId: client.id,
          playerId: client.playerId,
          name: client.name,
          room,
          timestamp: Date.now()
        },
        client.id
      );

      // If cached state exists, also send current snapshot right away
      const cached = roomStates.get(room);
      if (cached && cached.state) {
        sendToClient(client, {
          type: 'STATE_SYNC',
          room,
          state: cached.state,
          senderId: cached.hostId,
          timestamp: cached.updatedAt
        });
      }

      broadcastPresence(room);
      break;
    }

    case 'STATE_SYNC': {
      if (msg.state) {
        roomStates.set(room, {
          state: msg.state,
          hostId: client.id,
          updatedAt: Date.now()
        });
        broadcastRoom(
          room,
          {
            type: 'STATE_SYNC',
            room,
            state: msg.state,
            eventCue: msg.eventCue || null,
            senderId: client.id,
            timestamp: Date.now()
          },
          client.id
        );
      }
      break;
    }

    case 'REQUEST_STATE': {
      const cached = roomStates.get(room);
      if (cached && cached.state) {
        sendToClient(client, {
          type: 'STATE_SYNC',
          room,
          state: cached.state,
          senderId: cached.hostId,
          timestamp: cached.updatedAt
        });
      }
      broadcastRoom(
        room,
        {
          type: 'REQUEST_STATE',
          requesterId: client.id,
          room
        },
        client.id
      );
      break;
    }

    case 'PLAYER_ACTION': {
      broadcastRoom(
        room,
        {
          type: 'PLAYER_ACTION',
          peerId: client.id,
          playerId: msg.playerId || client.playerId,
          action: msg.action || null,
          payload: msg.payload || null,
          room,
          timestamp: Date.now()
        },
        client.id
      );
      break;
    }

    case 'PING': {
      sendToClient(client, { type: 'PONG', timestamp: Date.now() });
      break;
    }

    default: {
      broadcastRoom(
        room,
        {
          ...msg,
          senderId: client.id,
          room
        },
        client.id
      );
      break;
    }
  }
}

/**
 * Parse incoming raw TCP buffer chunks into complete RFC 6455 frames
 */
function parseFramesFromBuffer(client) {
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];

    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (client.buffer.length < 4) return;
      payloadLen = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (client.buffer.length < 10) return;
      const bigLen = client.buffer.readBigUInt64BE(2);
      payloadLen = Number(bigLen);
      offset = 10;
    }

    const maskKeyLen = isMasked ? 4 : 0;
    const totalFrameLen = offset + maskKeyLen + payloadLen;

    if (client.buffer.length < totalFrameLen) {
      return;
    }

    let maskKey = null;
    if (isMasked) {
      maskKey = client.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLen));
    client.buffer = client.buffer.subarray(totalFrameLen);

    if (isMasked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i & 3];
      }
    }

    if (opcode === 0x08) {
      try {
        client.socket.write(encodeWsControlFrame(0x08));
        client.socket.end();
      } catch {
        client.socket.destroy();
      }
      return;
    } else if (opcode === 0x09) {
      try {
        client.socket.write(encodeWsControlFrame(0x0a, payload));
      } catch {
        // Ignore
      }
    } else if (opcode === 0x01 || opcode === 0x02) {
      const text = payload.toString('utf8');
      handleClientMessage(client, text);
    }
  }
}

/**
 * Upgrade an HTTP request to a raw RFC 6455 WebSocket connection
 */
function handleWebSocketUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(responseHeaders.join('\r\n'));
  socket.setNoDelay(true);

  const clientId = 'peer_' + crypto.randomBytes(4).toString('hex');
  const client = {
    id: clientId,
    socket,
    buffer: Buffer.alloc(0),
    room: 'MAIN',
    role: 'client',
    name: 'Player',
    playerId: null,
    connectedAt: Date.now()
  };

  clients.set(clientId, client);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    if (client.buffer.length > 5 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    parseFramesFromBuffer(client);
  });

  const cleanup = () => {
    if (clients.has(clientId)) {
      const room = client.room;
      clients.delete(clientId);
      broadcastPresence(room);
    }
  };

  socket.on('close', cleanup);
  socket.on('end', cleanup);
  socket.on('error', cleanup);
}

/**
 * HTTP Request Handler
 */
function handleHttpRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/lan-info') {
    const ips = getLocalIPv4Addresses();
    const primaryIp = ips[0] ? ips[0].address : '127.0.0.1';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        primaryIp,
        ips,
        httpPort: PRIMARY_PORT,
        wsPort: SECONDARY_WS_PORT,
        connectedPeers: clients.size,
        rooms: Array.from(roomStates.keys())
      })
    );
    return;
  }

  if (pathname === '/download/server.js' || pathname === '/server.js') {
    const serverPath = path.join(__dirname, 'server.js');
    try {
      const content = fs.readFileSync(serverPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="server.js"'
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('server.js not found');
    }
    return;
  }

  if (pathname === '/manifest.json') {
    const manifestPath = path.join(__dirname, 'manifest.json');
    try {
      const json = fs.readFileSync(manifestPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(json);
      return;
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  if (pathname === '/sw.js') {
    const swPath = path.join(__dirname, 'sw.js');
    try {
      const js = fs.readFileSync(swPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(js);
      return;
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(html);
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading index.html: ' + err.message);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

const primaryServer = http.createServer(handleHttpRequest);
primaryServer.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket));

primaryServer.listen(PRIMARY_PORT, '0.0.0.0', () => {
  const ips = getLocalIPv4Addresses();
  console.log('==================================================================');
  console.log('  ALL IN — OFFLINE POKER CHIPS HOTSPOT RELAY SERVER');
  console.log('==================================================================');
  console.log(`  Listening on port ${PRIMARY_PORT}`);
  for (const item of ips) {
    console.log(`  -> Join URL:   http://${item.address}:${PRIMARY_PORT}/?join=1`);
    console.log(`  -> WebSocket:  ws://${item.address}:${PRIMARY_PORT}`);
  }
});

if (PRIMARY_PORT !== SECONDARY_WS_PORT) {
  const secondaryServer = http.createServer(handleHttpRequest);
  secondaryServer.on('upgrade', (req, socket) => handleWebSocketUpgrade(req, socket));
  secondaryServer.on('error', () => {});
  secondaryServer.listen(SECONDARY_WS_PORT, '0.0.0.0', () => {
    const ips = getLocalIPv4Addresses();
    for (const item of ips) {
      console.log(`  -> Hotspot 8080: http://${item.address}:${SECONDARY_WS_PORT}/?join=1`);
    }
    console.log('==================================================================');
  });
}
