class CoreEntity {
  constructor(id, type, x, y, mass, color = '#fff', isSpiky = false) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.mass = mass;
    this.radius = Math.sqrt(mass) * 6;
    this.color = color;
    this.isSpiky = isSpiky;
  }

  updateRadius() {
    this.radius = Math.sqrt(this.mass) * 6;
  }

  updatePosition(worldSize, friction = 0.85) {
    this.prevX = this.x;
    this.prevY = this.y;
    this.x += this.vx;
    this.y += this.vy;
    this.vx *= friction;
    this.vy *= friction;

    this.x = Math.max(this.radius, Math.min(worldSize - this.radius, this.x));
    this.y = Math.max(this.radius, Math.min(worldSize - this.radius, this.y));
  }

  addMass(n) {
    this.mass = Math.min(this.mass + n,22500);
  }
}

module.exports = CoreEntity;