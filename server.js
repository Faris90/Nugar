// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const url = require('url');

const app = express();
const server = http.createServer(app);

// VPS Optimization: Enable zlib compression to reduce bandwidth under load
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    threshold: 512
  }
});

app.use(express.static('public'));

// Configuration inheritance and parsing logic
function parseIni(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith(';')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join('=').trim();
          acc[key] = isNaN(value) ? value : Number(value);
        }
      }
      return acc;
    }, {});
}

function loadConfig(filePath) {
  const baseConfig = fs.existsSync('./config.ini') ? parseIni('./config.ini') : {};
  if (!filePath || filePath === './config.ini' || !fs.existsSync(filePath)) {
    return baseConfig;
  }
  const roomConfig = parseIni(filePath);
  // Room-specific settings override global config.ini values (including TEAM_MODE & gamemodes)
  return { ...baseConfig, ...roomConfig };
}

const FoodEntity = require('./entity/Food');
const VirusEntity = require('./entity/Virus');
const EjectedEntity = require('./entity/EjectedMass');
const PlayerCellEntity = require('./entity/PlayerCell');

const COLORS = ['#ff4d4d', '#33ca7f', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899'];
const TEAMS = [
  { id: 'red', name: 'Red', color: '#ff4d4d' },
  { id: 'blue', name: 'Blue', color: '#3b82f6' },
  { id: 'green', name: 'Green', color: '#33ca7f' },
  { id: 'purple', name: 'Purple', color: '#8b5cf6' }
];

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

class Room {
  constructor(name, configPath) {
    this.name = name;
    this.config = loadConfig(configPath);

    this.WORLD_SIZE = this.config.WORLD_SIZE ?? 8000;
    this.INITIAL_MASS = this.config.INITIAL_MASS ?? 20;
    this.MIN_SPLIT_MASS = this.config.MIN_SPLIT_MASS ?? 36;
    this.EJECT_MASS_COST = this.config.EJECT_MASS_COST ?? 15;
    this.EJECT_MASS_VALUE = this.config.EJECT_MASS_VALUE ?? 12;
    this.FOOD_MASS = this.config.FOOD_MASS ?? 5;
    this.MAX_PLAYER_CELLS = this.config.MAX_PLAYER_CELLS ?? 16;
    this.FOOD_COUNT = this.config.FOOD_COUNT ?? 1000;
    this.VIRUS_COUNT = this.config.VIRUS_COUNT ?? 30;
    this.BOT_COUNT = this.config.BOT_COUNT ?? 50;
    this.SPAWN_PROTECTION_DURATION = this.config.SPAWN_PROTECTION_DURATION ?? 5000;
    this.MERGE_TIME = this.config.MERGE_TIME ?? 15;
    this.DYNAMIC_MERGE_TIME = this.config.DYNAMIC_MERGE_TIME ?? 1;
    this.TEAM_MODE = this.config.TEAM_MODE ?? 0;

    this.entities = [];
    this.players = {};
    this.entityIdCounter = 1;
    this.frameCounter = 0;

    this.initWorld();
    this.startLoop();
  }

  getMergeTimeForCell(mass) {
    const baseSeconds = this.MERGE_TIME;
    if (!this.DYNAMIC_MERGE_TIME) {
      return baseSeconds * 1000;
    }
    const scaledSeconds = baseSeconds + (mass * 0.04);
    return scaledSeconds * 1000;
  }

  getBalancedTeam() {
    const counts = {};
    TEAMS.forEach(t => counts[t.id] = 0);
    Object.values(this.players).forEach(p => {
      if (p.team && counts[p.team] !== undefined) counts[p.team]++;
    });
    let selected = TEAMS[0];
    let min = Infinity;
    TEAMS.forEach(t => {
      if (counts[t.id] < min) {
        min = counts[t.id];
        selected = t;
      }
    });
    return selected;
  }

  initWorld() {
    for (let i = 0; i < this.FOOD_COUNT; i++) this.spawnFood();
    for (let i = 0; i < this.VIRUS_COUNT; i++) this.spawnVirus();
    for (let i = 0; i < this.BOT_COUNT; i++) this.spawnBot();
  }

  spawnFood() {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    this.entities.push(new FoodEntity(this.entityIdCounter++, Math.random() * this.WORLD_SIZE, Math.random() * this.WORLD_SIZE, color, this.FOOD_MASS));
  }

  spawnVirus() {
    const x = Math.random() * (this.WORLD_SIZE - 400) + 200;
    const y = Math.random() * (this.WORLD_SIZE - 400) + 200;
    this.entities.push(new VirusEntity(this.entityIdCounter++, x, y));
  }

  spawnBot() {
    const botId = 'bot_' + Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const spawnX = Math.random() * (this.WORLD_SIZE - 1000) + 500;
    const spawnY = Math.random() * (this.WORLD_SIZE - 1000) + 500;
    const team = this.TEAM_MODE ? this.getBalancedTeam() : null;
    const color = team ? team.color : COLORS[Math.floor(Math.random() * COLORS.length)];

    this.players[botId] = {
      id: botId,
      name: 'Bot_' + Math.floor(Math.random() * 900 + 100),
      color: color,
      team: team ? team.id : null,
      skin: null,
      isBot: true,
      wanderTarget: null,
      cells: [new PlayerCellEntity(this.entityIdCounter++, spawnX, spawnY, this.INITIAL_MASS, color, now + this.SPAWN_PROTECTION_DURATION)],
      input: { offsetX: 0, offsetY: 0 }
    };
  }

  addClient(ws) {
    const playerId = 'player_' + Math.random().toString(36).substr(2, 9);
    ws.playerId = playerId;
    ws.room = this;
    const now = Date.now();
    const spawnX = Math.random() * (this.WORLD_SIZE - 1000) + 500;
    const spawnY = Math.random() * (this.WORLD_SIZE - 1000) + 500;
    const team = this.TEAM_MODE ? this.getBalancedTeam() : null;
    const color = team ? team.color : COLORS[Math.floor(Math.random() * COLORS.length)];
    
    this.players[playerId] = {
      id: playerId,
      name: 'Cell',
      color: color,
      team: team ? team.id : null,
      skin: null,
      isBot: false,
      cells: [new PlayerCellEntity(this.entityIdCounter++, spawnX, spawnY, this.INITIAL_MASS, color, now + this.SPAWN_PROTECTION_DURATION)],
      input: { offsetX: 0, offsetY: 0 }
    };

    ws.send(JSON.stringify({ type: 'init', playerId, worldSize: this.WORLD_SIZE }));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        const p = this.players[playerId];
        if (!p) return;

        if (data.type === 'target') {
          // Rate-limit only high-frequency mouse tracking packets to prevent flooding
          const packetTime = Date.now();
          if (ws.lastTargetTime && packetTime - ws.lastTargetTime < 25) return;
          ws.lastTargetTime = packetTime;

          p.input.offsetX = data.offsetX;
          p.input.offsetY = data.offsetY;
        } else if (data.type === 'split') {
          this.splitPlayer(p);
        } else if (data.type === 'eject') {
          this.ejectMass(p);
        } else if (data.type === 'join') {
          p.name = data.name.trim().slice(0, 12) || 'Unnamed';
          p.skin = data.skin ? data.skin.trim().slice(0, 255) : null;
          p.cells = [];
          const rx = Math.random() * (this.WORLD_SIZE - 1000) + 500;
          const ry = Math.random() * (this.WORLD_SIZE - 1000) + 500;
          const respawnNow = Date.now();
          p.cells.push(new PlayerCellEntity(
            this.entityIdCounter++, 
            rx, ry, 
            this.INITIAL_MASS, 
            p.color, 
            respawnNow + this.SPAWN_PROTECTION_DURATION
          ));
        }
      } catch (e) {}
    });

    ws.on('close', () => { if (ws.playerId) delete this.players[ws.playerId]; });
    ws.on('error', () => { if (ws.playerId) delete this.players[ws.playerId]; });
  }

  splitPlayer(player) {
    if (player.cells.length >= this.MAX_PLAYER_CELLS) return;

    const newCells = [];
    const now = Date.now();

    player.cells.forEach(cell => {
      if (cell.mass >= this.MIN_SPLIT_MASS && player.cells.length + newCells.length < this.MAX_PLAYER_CELLS) {
        cell.mass /= 2;
        cell.updateRadius();
        cell.canMergeAfter = now + this.getMergeTimeForCell(cell.mass);

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

        const splitCell = new PlayerCellEntity(this.entityIdCounter++, targetX, targetY, cell.mass, player.color, cell.spawnProtectedUntil);
        splitCell.vx = Math.cos(angle) * splitImpulse;
        splitCell.vy = Math.sin(angle) * splitImpulse;
        splitCell.canMergeAfter = now + this.getMergeTimeForCell(splitCell.mass);
        newCells.push(splitCell);
      }
    });

    player.cells.push(...newCells);
  }

  ejectMass(player) {
    const offsetX = player.input.offsetX || 0;
    const offsetY = player.input.offsetY || 0;

    if ((offsetX === 0 && offsetY === 0) || player.cells.length === 0) return;

    let avgX = 0, avgY = 0;
    player.cells.forEach(c => { avgX += c.x; avgY += c.y; });
    avgX /= player.cells.length;
    avgY /= player.cells.length;

    const mouseWorldX = avgX + offsetX;
    const mouseWorldY = avgY + offsetY;

    player.cells.forEach(cell => {
      if (cell.mass >= this.INITIAL_MASS + this.EJECT_MASS_COST) {
        cell.mass -= this.EJECT_MASS_COST;
        cell.updateRadius();

        // Every cell aims independently toward the mouse pointer
        const angle = Math.atan2(mouseWorldY - cell.y, mouseWorldX - cell.x);
        const dispersedAngle = angle + (Math.random() * 0.4) - 0.2;
        const spawnDist = cell.radius + 10;

        this.entities.push(new EjectedEntity(
          this.entityIdCounter++,
          cell.x + Math.cos(angle) * spawnDist,
          cell.y + Math.sin(angle) * spawnDist,
          Math.cos(dispersedAngle) * 90,
          Math.sin(dispersedAngle) * 90,
          player.color
        ));
      }
    });
  }

  explodeCellOnVirus(player, cell) {
    const maxNew = this.MAX_PLAYER_CELLS - player.cells.length;
    if (maxNew <= 0) return;

    const pieces = Math.min(maxNew, Math.floor(cell.mass / 20));
    if (pieces <= 0) return;

    const newMass = cell.mass / (pieces + 1);
    cell.mass = newMass;
    cell.updateRadius();
    cell.canMergeAfter = Date.now() + this.getMergeTimeForCell(cell.mass);

    for (let i = 0; i < pieces; i++) {
      const angle = (Math.PI * 2 / pieces) * i;
      const splitCell = new PlayerCellEntity(this.entityIdCounter++, cell.x, cell.y, newMass, player.color, cell.spawnProtectedUntil);
      splitCell.vx = Math.cos(angle) * 20;
      splitCell.vy = Math.sin(angle) * 20;
      splitCell.canMergeAfter = Date.now() + this.getMergeTimeForCell(splitCell.mass);
      player.cells.push(splitCell);
    }
  }

  startLoop() {
    setInterval(() => {
      const now = Date.now();
      this.frameCounter++;

      const CHUNK_SIZE = 800;
      const spatialGrid = new SpatialGrid(CHUNK_SIZE);

      for (let i = 0; i < this.entities.length; i++) {
        spatialGrid.insertEntity(this.entities[i]);
      }
      const allPlayersArr = Object.values(this.players);
      for (let i = 0; i < allPlayersArr.length; i++) {
        const p = allPlayersArr[i];
        for (let j = 0; j < p.cells.length; j++) {
          spatialGrid.insertPlayerCell(p, p.cells[j]);
        }
      }

      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i];
        if (e.type === 'virus') {
          e.updatePosition(this.WORLD_SIZE, 0.85);
        }
      }

      const viruses = this.entities.filter(e => e.type === 'virus');
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

            v1.x = Math.max(v1.radius, Math.min(this.WORLD_SIZE - v1.radius, v1.x));
            v1.y = Math.max(v1.radius, Math.min(this.WORLD_SIZE - v1.radius, v1.y));
            v2.x = Math.max(v2.radius, Math.min(this.WORLD_SIZE - v2.radius, v2.x));
            v2.y = Math.max(v2.radius, Math.min(this.WORLD_SIZE - v2.radius, v2.y));
          }
        }
      }

      allPlayersArr.forEach((p, index) => {
        if (p.isBot && p.cells.length > 0) {
          if (index % 10 !== this.frameCounter % 10) return;

          const cell = p.cells[0];
          const localQuery = spatialGrid.query(cell.x, cell.y, 600);
          
          let nearestFood = null;
          let minDistFood = Infinity;

          for (let i = 0; i < localQuery.entities.length; i++) {
            const e = localQuery.entities[i];
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
          localQuery.players.forEach(otherP => {
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
                x: Math.max(200, Math.min(this.WORLD_SIZE - 200, cell.x + (Math.random() - 0.5) * 1500)),
                y: Math.max(200, Math.min(this.WORLD_SIZE - 200, cell.y + (Math.random() - 0.5) * 1500))
              };
            }
            targetWorldX = p.wanderTarget.x;
            targetWorldY = p.wanderTarget.y;
          }

          p.input.offsetX = targetWorldX - cell.x;
          p.input.offsetY = targetWorldY - cell.y;
        }
      });

      for (let i = this.entities.length - 1; i >= 0; i--) {
        const e = this.entities[i];
        if (e.type === 'ejected') {
          e.updatePosition(this.WORLD_SIZE, 0.82);

          if (e.x <= 0 || e.x >= this.WORLD_SIZE || e.y <= 0 || e.y >= this.WORLD_SIZE) {
            this.entities.splice(i, 1);
            continue;
          }

          for (let j = this.entities.length - 1; j >= 0; j--) {
            const v = this.entities[j];
            if (v.type === 'virus') {
              const dist = Math.hypot(e.x - v.x, e.y - v.y);
              if (dist < v.radius + e.radius) {
                const angle = Math.atan2(e.vy, e.vx) || Math.atan2(v.y - e.y, v.x - e.x);
                const pushForce = 12;
                v.vx += Math.cos(angle) * pushForce;
                v.vy += Math.sin(angle) * pushForce;
                v.feedCount = (v.feedCount || 0) + 1;

                if (v.feedCount >= 7) {
                  v.feedCount = 0;
                  const shotSpeed = 60;
                  const newVirus = new VirusEntity(
                    this.entityIdCounter++,
                    v.x + Math.cos(angle) * (v.radius + 20),
                    v.y + Math.sin(angle) * (v.radius + 20)
                  );
                  newVirus.vx = Math.cos(angle) * shotSpeed;
                  newVirus.vy = Math.sin(angle) * shotSpeed;
                  this.entities.push(newVirus);
                }

                this.entities.splice(i, 1);
                break;
              }
            }
          }
        }
      }

      allPlayersArr.forEach(p => {
        const offsetX = p.input.offsetX || 0;
        const offsetY = p.input.offsetY || 0;

        let avgX = 0, avgY = 0;
        p.cells.forEach(c => { avgX += c.x; avgY += c.y; });
        if (p.cells.length > 0) {
          avgX /= p.cells.length;
          avgY /= p.cells.length;
        } else {
          avgX = this.WORLD_SIZE / 2;
          avgY = this.WORLD_SIZE / 2;
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

          cell.updatePosition(this.WORLD_SIZE, 0.85);

          if (cell.mass > this.INITIAL_MASS * 2) {
            cell.mass -= cell.mass * 0.00008;
            cell.updateRadius();
          }
        });

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

      allPlayersArr.forEach(p => {
        p.cells.forEach(cell => {
          const localQuery = spatialGrid.query(cell.x, cell.y, cell.radius + 100);

          for (let i = 0; i < localQuery.entities.length; i++) {
            const e = localQuery.entities[i];
            const entityIndex = this.entities.indexOf(e);
            if (entityIndex === -1) continue;

            if (e.type === 'food') {
              const maxEatDist = cell.radius + e.radius + 8;
              const distSq = distToSegmentSquared(e.x, e.y, cell.prevX, cell.prevY, cell.x, cell.y);

              if (distSq <= maxEatDist * maxEatDist) {
                cell.addMass(e.mass);
                cell.updateRadius();
                this.entities.splice(entityIndex, 1);
                this.spawnFood();
              }
            } else if (e.type === 'ejected') {
              const dist = Math.hypot(cell.x - e.x, cell.y - e.y);
              if (dist <= cell.radius + e.radius * 0.5 + 5) {
                cell.addMass(e.mass);
                cell.updateRadius();
                this.entities.splice(entityIndex, 1);
              }
            } else if (e.type === 'virus') {
              const dist = Math.hypot(cell.x - e.x, cell.y - e.y);
              if (dist < cell.radius + e.radius) {
                if (cell.mass > e.mass * 1.15) {
                  cell.addMass(e.mass);
                  this.explodeCellOnVirus(p, cell);
                  this.entities.splice(entityIndex, 1);
                  this.spawnVirus();
                }
              }
            }
          }
        });
      });

      const allPlayerCells = [];
      allPlayersArr.forEach(p => {
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

          if (this.TEAM_MODE && item1.player.team === item2.player.team) {
            const minDist = c1.radius + c2.radius;
            if (dist < minDist) {
              const overlap = minDist - dist;
              const nx = (c2.x - c1.x) / (dist || 1);
              const ny = (c2.y - c1.y) / (dist || 1);
              c1.x -= nx * overlap * 0.5;
              c1.y -= ny * overlap * 0.5;
              c2.x += nx * overlap * 0.5;
              c2.y += ny * overlap * 0.5;
            }
            continue;
          }

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
        allPlayersArr.forEach(p => {
          p.cells = p.cells.filter(cell => !cellsToRemove.has(cell));
        });
      }

      Object.keys(this.players).forEach(id => {
        const p = this.players[id];
        if (p.isBot && p.cells.length === 0) {
          delete this.players[id];
        }
      });

      const activeBots = Object.values(this.players).filter(p => p.isBot).length;
      for (let i = activeBots; i < this.BOT_COUNT; i++) {
        this.spawnBot();
      }

      let leaderboard;
      if (this.TEAM_MODE) {
        const teamMasses = {};
        TEAMS.forEach(t => teamMasses[t.id] = { name: t.name, color: t.color, mass: 0 });
        Object.values(this.players).forEach(p => {
          if (p.team && teamMasses[p.team]) {
            const totalMass = p.cells.reduce((sum, c) => sum + c.mass, 0);
            teamMasses[p.team].mass += totalMass;
          }
        });
        const totalWorldMass = Object.values(teamMasses).reduce((sum, t) => sum + t.mass, 0) || 1;
        leaderboard = Object.values(teamMasses).map(t => ({
          name: t.name,
          color: t.color,
          mass: Math.floor(t.mass),
          percentage: Number(((t.mass / totalWorldMass) * 100).toFixed(1))
        }));
      } else {
        leaderboard = Object.values(this.players).map(p => {
          const totalMass = p.cells.reduce((sum, c) => sum + c.mass, 0);
          return { id: p.id, name: p.name || 'Unnamed', mass: Math.floor(totalMass) };
        }).sort((a, b) => b.mass - a.mass).slice(0, 10);
      }

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.playerId && client.room === this) {
          const p = this.players[client.playerId];
          if (!p) return;

          let centerX = this.WORLD_SIZE / 2;
          let centerY = this.WORLD_SIZE / 2;
          let viewRadius = 1500;

          if (p.cells.length > 0) {
            let sumX = 0, sumY = 0, maxRadius = 0;
            for (let i = 0; i < p.cells.length; i++) {
              sumX += p.cells[i].x; 
              sumY += p.cells[i].y;
              if (p.cells[i].radius > maxRadius) maxRadius = p.cells[i].radius;
            }
            centerX = sumX / p.cells.length;
            centerY = sumY / p.cells.length;
            viewRadius = Math.max(1500, maxRadius * 6);
          }

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
  }
}

function distToSegmentSquared(px, py, ax, ay, bx, by) {
  const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
  if (l2 === 0) return (px - ax) ** 2 + (py - ay) ** 2;
  let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = ax + t * (bx - ax);
  const projY = ay + t * (by - ay);
  return (px - projX) ** 2 + (py - projY) ** 2;
}

const rooms = {};
rooms['default'] = new Room('default', './config.ini');

const roomsDir = './rooms';
if (fs.existsSync(roomsDir)) {
  fs.readdirSync(roomsDir).forEach(file => {
    if (file.endsWith('.ini')) {
      const roomName = file.substring(0, file.lastIndexOf('.'));
      rooms[roomName] = new Room(roomName, `${roomsDir}/${file}`);
    }
  });
}

app.get('/api/rooms', (req, res) => {
  const list = Object.keys(rooms).map(name => ({
    name,
    players: Object.values(rooms[name].players).filter(p => !p.isBot).length,
    teamMode: rooms[name].TEAM_MODE
  }));
  res.json(list);
});

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  let roomName = parsedUrl.query.room;
  if (!roomName) {
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (segments.length > 0 && rooms[segments[0]]) {
      roomName = segments[0];
    }
  }
  const targetRoom = rooms[roomName] || rooms['default'];
  targetRoom.addClient(ws);
});

server.listen(3000, () => console.log('Optimized VPS multi-room server running on port 3000'));