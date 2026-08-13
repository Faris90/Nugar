const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

const WORLD_SIZE = 8000;
const MAX_FOOD = 1200;
const MAX_VIRUSES = 30;

let entities = []; // Contains food, viruses, ejected mass
let players = new Map(); // Map of player objects
let nextEntityId = 1;

const getRadius = (mass) => Math.sqrt(mass) * 6;

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

function initWorld() {
  for (let i = 0; i < MAX_FOOD; i++) {
    entities.push({
      id: nextEntityId++,
      type: 'food',
      x: Math.random() * WORLD_SIZE,
      y: Math.random() * WORLD_SIZE,
      mass: 1,
      radius: getRadius(1),
      color: getRandomColor()
    });
  }

  for (let i = 0; i < MAX_VIRUSES; i++) {
    entities.push({
      id: nextEntityId++,
      type: 'virus',
      isSpiky: true,
      x: Math.random() * (WORLD_SIZE - 400) + 200,
      y: Math.random() * (WORLD_SIZE - 400) + 200,
      mass: 100,
      radius: getRadius(100),
      color: '#33ff33'
    });
  }
}
initWord = initWorld();

wss.on('connection', (ws) => {
  const playerId = nextEntityId++;
  let player = {
    id: playerId,
    name: 'Unnamed',
    color: getRandomColor(),
    cells: [],
    ws: ws
  };

  players.set(playerId, player);

  ws.send(JSON.stringify({
    type: 'init',
    playerId: playerId,
    worldSize: WORLD_SIZE
  }));

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'join') {
        player.name = msg.name.slice(0, 12) || 'Unnamed';
        // Spawn initial cell
        player.cells.push({
          id: nextEntityId++,
          x: Math.random() * (WORLD_SIZE - 1000) + 500,
          y: Math.random() * (WORLD_SIZE - 1000) + 500,
          mass: 15,
          radius: getRadius(15),
          vx: 0,
          vy: 0,
          canMergeAfter: Date.now() + 30000
        });
      } else if (msg.type === 'target') {
        player.targetOffsetX = msg.offsetX;
        player.targetOffsetY = msg.offsetY;
      } else if (msg.type === 'split') {
        splitPlayerCells(player);
      } else if (msg.type === 'eject') {
        ejectMass(player);
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', () => {
    players.delete(playerId);
  });
});

function splitPlayerCells(player) {
  const newCells = [];
  player.cells.forEach(cell => {
    if (cell.mass >= 36 && player.cells.length + newCells.length < 16) {
      const halfMass = cell.mass / 2;
      cell.mass = halfMass;
      cell.radius = getRadius(cell.mass);

      const angle = Math.atan2(player.targetOffsetY || 0, player.targetOffsetX || 1);
      const splitDist = cell.radius * 2;

      newCells.push({
        id: nextEntityId++,
        x: cell.x + Math.cos(angle) * splitDist,
        y: cell.y + Math.sin(angle) * splitDist,
        mass: halfMass,
        radius: getRadius(halfMass),
        vx: Math.cos(angle) * 25,
        vy: Math.sin(angle) * 25,
        canMergeAfter: Date.now() + 15000
      });
    }
  });
  player.cells.push(...newCells);
}

function ejectMass(player) {
  const ejected = [];
  player.cells.forEach(cell => {
    if (cell.mass >= 36) {
      cell.mass -= 14;
      cell.radius = getRadius(cell.mass);

      const angle = Math.atan2(player.targetOffsetY || 0, player.targetOffsetX || 1);
      ejected.push({
        id: nextEntityId++,
        type: 'ejected',
        x: cell.x + Math.cos(angle) * (cell.radius + 15),
        y: cell.y + Math.sin(angle) * (cell.radius + 15),
        mass: 12,
        radius: getRadius(12),
        color: player.color,
        vx: Math.cos(angle) * 18,
        vy: Math.sin(angle) * 18
      });
    }
  });
  entities.push(...ejected);
}

// Main Game Loop (30 FPS)
setInterval(() => {
  const now = Date.now();

  // 1. Update Viruses (Soft Overlap / Push-apart Physics)
  let viruses = entities.filter(e => e.type === 'virus');
  for (let i = 0; i < viruses.length; i++) {
    for (let j = i + 1; j < viruses.length; j++) {
      let v1 = viruses[i];
      let v2 = viruses[j];
      let dx = v2.x - v1.x;
      let dy = v2.y - v1.y;
      let dist = Math.hypot(dx, dy);
      let minDist = v1.radius + v2.radius;

      if (dist < minDist) {
        let overlap = minDist - dist;
        let angle = Math.atan2(dy, dx);
        let push = overlap * 0.15;

        // Smoothly push both viruses apart while allowing overlap intersection
        v1.x -= Math.cos(angle) * push;
        v1.y -= Math.sin(angle) * push;
        v2.x += Math.cos(angle) * push;
        v2.y += Math.sin(angle) * push;

        v1.x = Math.max(v1.radius, Math.min(WORLD_SIZE - v1.radius, v1.x));
        v1.y = Math.max(v1.radius, Math.min(WORLD_SIZE - v1.radius, v1.y));
        v2.x = Math.max(v2.radius, Math.min(WORLD_SIZE - v2.radius, v2.x));
        v2.y = Math.max(v2.radius, Math.min(WORLD_SIZE - v2.radius, v2.y));
      }
    }
  }

  // 2. Replenish Food
  while (entities.filter(e => e.type === 'food').length < MAX_FOOD) {
    entities.push({
      id: nextEntityId++,
      type: 'food',
      x: Math.random() * WORLD_SIZE,
      y: Math.random() * WORLD_SIZE,
      mass: 1,
      radius: getRadius(1),
      color: getRandomColor()
    });
  }

  // 3. Update Player Cells & Interactions
  players.forEach(player => {
    player.cells.forEach(cell => {
      if (player.targetOffsetX !== undefined && player.targetOffsetY !== undefined) {
        const dist = Math.hypot(player.targetOffsetX, player.targetOffsetY);
        if (dist > 5) {
          const angle = Math.atan2(player.targetOffsetY, player.targetOffsetX);
          const speed = Math.max(1.2, 12 * Math.pow(cell.mass, -0.25));
          cell.vx += Math.cos(angle) * speed * 0.2;
          cell.vy += Math.sin(angle) * speed * 0.2;
        }
      }

      cell.x += cell.vx;
      cell.y += cell.vy;
      cell.vx *= 0.85;
      cell.vy *= 0.85;

      cell.x = Math.max(cell.radius, Math.min(WORLD_SIZE - cell.radius, cell.x));
      cell.y = Math.max(cell.radius, Math.min(WORLD_SIZE - cell.radius, cell.y));

      // Food Collision
      entities = entities.filter(entity => {
        if (entity.type === 'food' || entity.type === 'ejected') {
          const d = Math.hypot(cell.x - entity.x, cell.y - entity.y);
          if (d < cell.radius + entity.radius) {
            cell.mass += entity.mass;
            cell.radius = getRadius(cell.mass);
            return false;
          }
        }
        return true;
      });
    });
  });

  // Build Leaderboard Data
  let allPlayersArray = [];
  players.forEach(p => {
    let totalMass = p.cells.reduce((sum, c) => sum + c.mass, 0);
    allPlayersArray.push({ id: p.id, name: p.name, mass: Math.floor(totalMass) });
  });
  allPlayersArray.sort((a, b) => b.mass - a.mass);
  const leaderboard = allPlayersArray.slice(0, 10);

  // Prepare State Payload
  const serializedPlayers = [];
  players.forEach(p => {
    serializedPlayers.push({
      id: p.id,
      name: p.name,
      color: p.color,
      cells: p.cells.map(c => ({
        id: c.id,
        x: c.x,
        y: c.y,
        mass: c.mass,
        vx: c.vx,
        vy: c.vy,
        canMergeAfter: c.canMergeAfter
      }))
    });
  });

  const statePayload = JSON.stringify({
    type: 'state',
    entities: entities.map(e => ({
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      mass: e.mass,
      color: e.color,
      isSpiky: e.isSpiky
    })),
    players: serializedPlayers,
    leaderboard
  });

  players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(statePayload);
    }
  });

}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});