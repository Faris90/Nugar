const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

// Parse config.ini
const config = fs.readFileSync('./config.ini', 'utf-8')
  .split(/\r?\n/)
  .reduce((acc, line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith(';')) {
      const [key, value] = trimmed.split('=');
      if (key && value) acc[key.trim()] = Number(value.trim());
    }
    return acc;
  }, {});

// Apply config variables using ?? to allow explicitly set 0 values
const WORLD_SIZE = config.WORLD_SIZE ?? 8000;
const INITIAL_MASS = config.INITIAL_MASS ?? 20;
const MIN_SPLIT_MASS = config.MIN_SPLIT_MASS ?? 36;
const EJECT_MASS_COST = config.EJECT_MASS_COST ?? 15;
const EJECT_MASS_VALUE = config.EJECT_MASS_VALUE ?? 12;
const FOOD_MASS = config.FOOD_MASS ?? 5;
const MAX_PLAYER_CELLS = config.MAX_PLAYER_CELLS ?? 16;
const FOOD_COUNT = config.FOOD_COUNT ?? 1000;
const VIRUS_COUNT = config.VIRUS_COUNT ?? 30;
const BOT_COUNT = config.BOT_COUNT ?? 10;
const SPAWN_PROTECTION_DURATION = config.SPAWN_PROTECTION_DURATION ?? 5000;
const MERGE_TIME = config.MERGE_TIME ?? 15;
const COLORS = ['#ff4d4d', '#33ca7f', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899'];

const CoreEntity = require('./entity/CoreEntity');
const FoodEntity = require('./entity/Food');
const VirusEntity = require('./entity/Virus');
const EjectedEntity = require('./entity/EjectedMass');
const PlayerCellEntity = require('./entity/PlayerCell');
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  _hash(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  insertEntity(entity) {
    const key = this._hash(entity.x, entity.y);
    if (!this.grid.has(key)) this.grid.set(key, { entities: [], players: new Map() });
    this.grid.get(key).entities.push(entity);
  }

  insertPlayerCell(player, cell) {
    const key = this._hash(cell.x, cell.y);
    if (!this.grid.has(key)) this.grid.set(key, { entities: [], players: new Map() });
    
    const gridNode = this.grid.get(key);
    if (!gridNode.players.has(player.id)) {
      gridNode.players.set(player.id, {
        id: player.id, name: player.name, color: player.color, skin: player.skin, cells: []
      });
    }
    
    gridNode.players.get(player.id).cells.push({
      id: cell.id, x: cell.x, y: cell.y, vx: cell.vx, vy: cell.vy, mass: cell.mass, 
      radius: cell.radius, isSpiky: cell.isSpiky, canMergeAfter: cell.canMergeAfter, 
      spawnProtectedUntil: cell.spawnProtectedUntil
    });
  }

  query(x, y, radius) {
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minY = Math.floor((y - radius) / this.cellSize);
    const maxY = Math.floor((y + radius) / this.cellSize);

    const resultEntities = [];
    const resultPlayersMap = new Map();

    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        const key = `${gx},${gy}`;
        const gridNode = this.grid.get(key);
        if (gridNode) {
          resultEntities.push(...gridNode.entities);
          
          gridNode.players.forEach((pData, pId) => {
            if (!resultPlayersMap.has(pId)) {
              resultPlayersMap.set(pId, { id: pData.id, name: pData.name, color: pData.color, skin: pData.skin, cells: [] });
            }
            resultPlayersMap.get(pId).cells.push(...pData.cells);
          });
        }
      }
    }
    return { entities: resultEntities, players: Array.from(resultPlayersMap.values()) };
  }
}

let entities = [];
let players = {};
let entityIdCounter = 1;
let frameCounter = 0;

function distToSegmentSquared(px, py, ax, ay, bx, by) {
  const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (l2 === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * (bx - ax);
  const projY = ay + t * (by - ay);
  return (px - projX) ** 2 + (py - projY) ** 2;
}

function initWorld() {
  for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
  for (let i = 0; i < VIRUS_COUNT; i++) spawnVirus();
  for (let i = 0; i < BOT_COUNT; i++) spawnBot();
}

function spawnFood() {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  entities.push(new FoodEntity(entityIdCounter++, Math.random() * WORLD_SIZE, Math.random() * WORLD_SIZE, color));
}

function spawnVirus() {
  const x = Math.random() * (WORLD_SIZE - 400) + 200;
  const y = Math.random() * (WORLD_SIZE - 400) + 200;
  entities.push(new VirusEntity(entityIdCounter++, x, y));
}

function spawnBot() {
  const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
  const now = Date.now();
  const spawnX = Math.random() * (WORLD_SIZE - 1000) + 500;
  const spawnY = Math.random() * (WORLD_SIZE - 1000) + 500;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  players[botId] = {
    id: botId,
    name: 'Bot_' + Math.floor(Math.random() * 900 + 100),
    color: color,
    skin: null,
    isBot: true,
    wanderTarget: null,
    cells: [new PlayerCellEntity(entityIdCounter++, spawnX, spawnY, INITIAL_MASS, color, now + SPAWN_PROTECTION_DURATION)],
    input: { offsetX: 0, offsetY: 0 }
  };
}

wss.on('connection', (ws) => {
  const playerId = 'player_' + Math.random().toString(36).substr(2, 9);
  ws.playerId = playerId;
  const now = Date.now();
  const spawnX = Math.random() * (WORLD_SIZE - 1000) + 500;
  const spawnY = Math.random() * (WORLD_SIZE - 1000) + 500;
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  
  players[playerId] = {
    id: playerId,
    name: 'Cell',
    color: color,
    skin: null,
    isBot: false,
    cells: [new PlayerCellEntity(entityIdCounter++, spawnX, spawnY, INITIAL_MASS, color, now + SPAWN_PROTECTION_DURATION)],
    input: { offsetX: 0, offsetY: 0 }
  };

  ws.send(JSON.stringify({ type: 'init', playerId, worldSize: WORLD_SIZE }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const p = players[playerId];
      if (!p) return;

      if (data.type === 'join') {
        p.name = data.name.trim().slice(0, 12) || 'Unnamed';
        p.skin = data.skin ? data.skin.trim().slice(0, 255) : null;
        
        if (p.cells.length > 0) {
        let totalMass = 0;
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let sumX = 0, sumY = 0;

        for (let i = 0; i < p.cells.length; i++) {
          const cell = p.cells[i];
          totalMass += cell.mass;
          sumX += cell.x; 
          sumY += cell.y;
          
          // Calculate the outer physical boundaries of all cells
          if (cell.x - cell.radius < minX) minX = cell.x - cell.radius;
          if (cell.x + cell.radius > maxX) maxX = cell.x + cell.radius;
          if (cell.y - cell.radius < minY) minY = cell.y - cell.radius;
          if (cell.y + cell.radius > maxY) maxY = cell.y + cell.radius;
        }
        
        centerX = sumX / p.cells.length;
        centerY = sumY / p.cells.length;
        
        const baseRadius = Math.sqrt(totalMass) * 6;
        const spreadX = (maxX - minX) / 2;
        const spreadY = (maxY - minY) / 2;
        const actualSpreadRadius = Math.max(spreadX, spreadY);
        
        const targetRadius = Math.max(baseRadius, actualSpreadRadius);

        // Match the client's 3.5x FOV padding + a little extra for network buffer
        viewRadius = Math.max(1500, targetRadius * 4.5);
      }
      } else if (data.type === 'target') {
        p.input.offsetX = data.offsetX;
        p.input.offsetY = data.offsetY;
      } else if (data.type === 'split') {
        splitPlayer(p);
      } else if (data.type === 'eject') {
        ejectMass(p);
      }
    } catch (e) {}
  });

  ws.on('close', () => { if (ws.playerId) delete players[ws.playerId]; });
  ws.on('error', () => { if (ws.playerId) delete players[ws.playerId]; });
});

function splitPlayer(player) {
  if (player.cells.length >= MAX_PLAYER_CELLS) return;

  const newCells = [];
  const now = Date.now();

  player.cells.forEach(cell => {
    if (cell.mass >= MIN_SPLIT_MASS && player.cells.length + newCells.length < MAX_PLAYER_CELLS) {
      cell.mass /= 2;
      cell.updateRadius();
      cell.canMergeAfter = now + MERGE_TIME * 1000;

      let avgX = 0, avgY = 0;
      player.cells.forEach(c => { avgX += c.x; avgY += c.y; });
      avgX /= player.cells.length;
      avgY /= player.cells.length;
      const mouseWorldX = avgX + (player.input.offsetX || 0);
      const mouseWorldY = avgY + (player.input.offsetY || 0);

      const angle = Math.atan2(mouseWorldY - cell.y, mouseWorldX - cell.x);
      const splitImpulse = 52;
      const targetX = cell.x + Math.cos(angle) * (cell.radius + 5);
      const targetY = cell.y + Math.sin(angle) * (cell.radius + 5);

      const splitCell = new PlayerCellEntity(entityIdCounter++, targetX, targetY, cell.mass, player.color, cell.spawnProtectedUntil);
      splitCell.vx = Math.cos(angle) * splitImpulse;
      splitCell.vy = Math.sin(angle) * splitImpulse;
      splitCell.canMergeAfter = now + MERGE_TIME * 1000;
      newCells.push(splitCell);
    }
  });

  player.cells.push(...newCells);
}

function ejectMass(player) {
  let avgX = 0, avgY = 0;
  player.cells.forEach(c => { avgX += c.x; avgY += c.y; });
  avgX /= player.cells.length;
  avgY /= player.cells.length;
  const mouseWorldX = avgX + (player.input.offsetX || 0);
  const mouseWorldY = avgY + (player.input.offsetY || 0);

  player.cells.forEach(cell => {
    if (cell.mass >= INITIAL_MASS + EJECT_MASS_COST) {
      cell.mass -= EJECT_MASS_COST;
      cell.updateRadius();

      const angle = Math.atan2(mouseWorldY - cell.y, mouseWorldX - cell.x);
      const spawnDist = cell.radius + 10;

      entities.push(new EjectedEntity(
        entityIdCounter++,
        cell.x + Math.cos(angle) * spawnDist,
        cell.y + Math.sin(angle) * spawnDist,
        Math.cos(angle) * 90,
        Math.sin(angle) * 90,
        player.color
      ));
    }
  });
}

function explodeCellOnVirus(player, cell) {
  const maxNew = MAX_PLAYER_CELLS - player.cells.length;
  if (maxNew <= 0) return;

  const pieces = Math.min(maxNew, Math.floor(cell.mass / 20));
  if (pieces <= 0) return;

  const newMass = cell.mass / (pieces + 1);
  cell.mass = newMass;
  cell.updateRadius();
  cell.canMergeAfter = Date.now() + MERGE_TIME * 1000;

  for (let i = 0; i < pieces; i++) {
    const angle = (Math.PI * 2 / pieces) * i;
    const splitCell = new PlayerCellEntity(entityIdCounter++, cell.x, cell.y, newMass, player.color, cell.spawnProtectedUntil);
    splitCell.vx = Math.cos(angle) * 20;
    splitCell.vy = Math.sin(angle) * 20;
    splitCell.canMergeAfter = Date.now() + MERGE_TIME * 1000;
    player.cells.push(splitCell);
  }
}

// Physics Loop (30 FPS)
setInterval(() => {
  const now = Date.now();
  frameCounter++;

  // Virus Overlap & Soft Repulsion
  const viruses = entities.filter(e => e.type === 'virus');
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

  // Bots
  Object.values(players).forEach((p, index) => {
    if (p.isBot && p.cells.length > 0) {
      if (index % 5 !== frameCounter % 5) return;

      const cell = p.cells[0];
      let nearestFood = null;
      let minDistFood = Infinity;

      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (e.type === 'food') {
          const dist = Math.hypot(e.x - cell.x, e.y - cell.y);
          if (dist < minDistFood) {
            minDistFood = dist;
            nearestFood = e;
          }
        }
      }

      let nearestThreat = null;
      let minDistThreat = Infinity;
      Object.values(players).forEach(otherP => {
        if (otherP.id === p.id) return;
        otherP.cells.forEach(oCell => {
          if (oCell.mass > cell.mass * 1.1) {
            const dist = Math.hypot(oCell.x - cell.x, oCell.y - cell.y);
            if (dist < minDistThreat) {
              minDistThreat = dist;
              nearestThreat = oCell;
            }
          }
        });
      });

      let targetWorldX = cell.x;
      let targetWorldY = cell.y;

      if (nearestThreat && minDistThreat < 400) {
        const angle = Math.atan2(cell.y - nearestThreat.y, cell.x - nearestThreat.x);
        targetWorldX = cell.x + Math.cos(angle) * 100;
        targetWorldY = cell.y + Math.sin(angle) * 100;
      } else if (nearestFood && minDistFood < 500) {
        targetWorldX = nearestFood.x;
        targetWorldY = nearestFood.y;
      } else {
        if (!p.wanderTarget || Math.hypot(p.wanderTarget.x - cell.x, p.wanderTarget.y - cell.y) < 100) {
          p.wanderTarget = {
            x: Math.max(200, Math.min(WORLD_SIZE - 200, cell.x + (Math.random() - 0.5) * 1500)),
            y: Math.max(200, Math.min(WORLD_SIZE - 200, cell.y + (Math.random() - 0.5) * 1500))
          };
        }
        targetWorldX = p.wanderTarget.x;
        targetWorldY = p.wanderTarget.y;
      }

      p.input.offsetX = targetWorldX - cell.x;
      p.input.offsetY = targetWorldY - cell.y;
    }
  });

  // Ejected Mass Movement
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    if (e.type === 'ejected') {
      e.updatePosition(WORLD_SIZE, 0.82);

      if (e.x <= 0 || e.x >= WORLD_SIZE || e.y <= 0 || e.y >= WORLD_SIZE) {
        entities.splice(i, 1);
      }
    }
  }

  // Player & Cell Movement (Per-Cell Mouse Targeting)
  Object.values(players).forEach(p => {
    const offsetX = p.input.offsetX || 0;
    const offsetY = p.input.offsetY || 0;

    let avgX = 0, avgY = 0;
    p.cells.forEach(c => { avgX += c.x; avgY += c.y; });
    if (p.cells.length > 0) {
      avgX /= p.cells.length;
      avgY /= p.cells.length;
    } else {
      avgX = WORLD_SIZE / 2;
      avgY = WORLD_SIZE / 2;
    }

    const mouseWorldX = avgX + offsetX;
    const mouseWorldY = avgY + offsetY;

    p.cells.forEach(cell => {
      cell.prevX = cell.x;
      cell.prevY = cell.y;

      const dx = mouseWorldX - cell.x;
      const dy = mouseWorldY - cell.y;
      const distToMouse = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const distScale = Math.min(1, distToMouse / 100);

      if (distToMouse > 5) {
        const baseSpeed = Math.max(1.5, 14 * Math.pow(cell.mass, -0.25)) * distScale;
        cell.vx += Math.cos(angle) * baseSpeed * 0.25;
        cell.vy += Math.sin(angle) * baseSpeed * 0.25;
      }

      cell.updatePosition(WORLD_SIZE, 0.85);

      if (cell.mass > INITIAL_MASS * 2) {
        cell.mass -= cell.mass * 0.00008;
        cell.updateRadius();
      }
    });

    // Same-player cell collisions & merging
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < p.cells.length; i++) {
        for (let j = i + 1; j < p.cells.length; j++) {
          const c1 = p.cells[i];
          const c2 = p.cells[j];
          const dx = c2.x - c1.x;
          const dy = c2.y - c1.y;
          const cellDist = Math.hypot(dx, dy) || 1;
          const minDist = c1.radius + c2.radius;

          if (now > c1.canMergeAfter && now > c2.canMergeAfter) {
            if (cellDist < c1.radius + c2.radius * 0.3) {
              c1.mass += c2.mass;
              c1.updateRadius();
              p.cells.splice(j, 1);
              j--;
            }
          } else if (cellDist < minDist) {
            const overlap = minDist - cellDist;
            const nx = dx / cellDist;
            const ny = dy / cellDist;

            const totalMass = c1.mass + c2.mass;
            const r1 = c2.mass / totalMass;
            const r2 = c1.mass / totalMass;

            c1.x -= nx * overlap * r1;
            c1.y -= ny * overlap * r1;
            c2.x += nx * overlap * r2;
            c2.y += ny * overlap * r2;

            const rvx = c2.vx - c1.vx;
            const rvy = c2.vy - c1.vy;
            const velAlongNormal = rvx * nx + rvy * ny;
            if (velAlongNormal < 0) {
              const impulse = -velAlongNormal * 0.8;
              c1.vx -= nx * impulse * r1;
              c1.vy -= ny * impulse * r1;
              c2.vx += nx * impulse * r2;
              c2.vy += ny * impulse * r2;
            }
          }
        }
      }
    }
  });

  // Food, Ejected Mass, and Virus Collisions for all player cells
  Object.values(players).forEach(p => {
    p.cells.forEach(cell => {
      for (let i = entities.length - 1; i >= 0; i--) {
        const e = entities[i];

        if (e.type === 'food') {
          const maxEatDist = cell.radius + e.radius + 8;
          const distSq = distToSegmentSquared(e.x, e.y, cell.prevX, cell.prevY, cell.x, cell.y);

          if (distSq <= maxEatDist * maxEatDist) {
            cell.mass += e.mass;
            cell.updateRadius();
            entities.splice(i, 1);
            spawnFood();
          }
        } else if (e.type === 'ejected') {
          const dist = Math.hypot(cell.x - e.x, cell.y - e.y);
          if (dist <= cell.radius + e.radius * 0.5 + 5) {
            cell.mass += e.mass;
            cell.updateRadius();
            entities.splice(i, 1);
          }
        } else if (e.type === 'virus') {
          const dist = Math.hypot(cell.x - e.x, cell.y - e.y);
          if (dist < cell.radius + e.radius) {
            if (cell.mass > e.mass * 1.15) {
              cell.mass += e.mass;
              explodeCellOnVirus(p, cell);
              entities.splice(i, 1);
              spawnVirus();
            }
          }
        }
      }
    });
  });

  // Player vs Player Eating
  const allPlayerCells = [];
  Object.values(players).forEach(p => {
    p.cells.forEach(cell => {
      allPlayerCells.push({ player: p, cell: cell });
    });
  });

  const cellsToRemove = new Set();

  for (let i = 0; i < allPlayerCells.length; i++) {
    const item1 = allPlayerCells[i];
    if (cellsToRemove.has(item1.cell)) continue;

    for (let j = i + 1; j < allPlayerCells.length; j++) {
      const item2 = allPlayerCells[j];
      if (cellsToRemove.has(item2.cell)) continue;
      if (item1.player.id === item2.player.id) continue;

      const c1 = item1.cell;
      const c2 = item2.cell;

      const dist = Math.hypot(c2.x - c1.x, c2.y - c1.y);

      const c1Protected = now < c1.spawnProtectedUntil;
      const c2Protected = now < c2.spawnProtectedUntil;

      if (!c2Protected && c1.mass > c2.mass * 1.10 && dist < c1.radius) {
        c1.mass += c2.mass;
        c1.updateRadius();
        cellsToRemove.add(c2);
      } else if (!c1Protected && c2.mass > c1.mass * 1.10 && dist < c2.radius) {
        c2.mass += c1.mass;
        c2.updateRadius();
        cellsToRemove.add(c1);
        break;
      }
    }
  }

  if (cellsToRemove.size > 0) {
    Object.values(players).forEach(p => {
      p.cells = p.cells.filter(cell => !cellsToRemove.has(cell));
    });
  }

  const activeBots = Object.values(players).filter(p => p.isBot).length;
  for (let i = activeBots; i < BOT_COUNT; i++) {
    spawnBot();
  }

  const leaderboard = Object.values(players).map(p => {
    const totalMass = p.cells.reduce((sum, c) => sum + c.mass, 0);
    return { id: p.id, name: p.name || 'Unnamed', mass: Math.floor(totalMass) };
  }).sort((a, b) => b.mass - a.mass).slice(0, 10);

  // ==========================================
  // SPATIAL GRID NETWORK VIEWPORT OPTIMIZATION
  // ==========================================
  const CHUNK_SIZE = 800; 
  const spatialGrid = new SpatialGrid(CHUNK_SIZE);

  // 1. Populate the grid with environment entities (Food, Viruses, Ejected Mass)
  for (let i = 0; i < entities.length; i++) {
    spatialGrid.insertEntity(entities[i]);
  }

  // 2. Populate the grid with all player and bot cells
  const allPlayers = Object.values(players);
  for (let i = 0; i < allPlayers.length; i++) {
    const p = allPlayers[i];
    for (let j = 0; j < p.cells.length; j++) {
      spatialGrid.insertPlayerCell(p, p.cells[j]);
    }
  }

  // 3. Query the grid and broadcast custom payloads to connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.playerId) {
      const p = players[client.playerId];
      if (!p) return;

      let centerX = WORLD_SIZE / 2;
      let centerY = WORLD_SIZE / 2;
      let viewRadius = 1500; // Base viewport cutoff radius

      if (p.cells.length > 0) {
        let sumX = 0, sumY = 0, maxRadius = 0;
        for (let i = 0; i < p.cells.length; i++) {
          sumX += p.cells[i].x; 
          sumY += p.cells[i].y;
          if (p.cells[i].radius > maxRadius) maxRadius = p.cells[i].radius;
        }
        centerX = sumX / p.cells.length;
        centerY = sumY / p.cells.length;
        
        // Scale the network chunk loading dynamically as the player gets larger and zooms out
        viewRadius = Math.max(1500, maxRadius * 6);
      }

      // Query the spatial grid for objects exclusively within this client's viewport
      const { entities: visibleEntities, players: visiblePlayers } = spatialGrid.query(centerX, centerY, viewRadius);

      const localizedSnapshot = JSON.stringify({
        type: 'state',
        entities: visibleEntities,
        leaderboard,
        players: visiblePlayers
      });

      client.send(localizedSnapshot);
    }
  });
}, 1000 / 30);

initWorld();
server.listen(3000, () => console.log('Server running on http://localhost:3000'));