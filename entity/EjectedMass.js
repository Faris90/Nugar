const CoreEntity = require('./CoreEntity');

class EjectedEntity extends CoreEntity {
  constructor(id, x, y, vx, vy, color, mass = 12) {
    super(id, 'ejected', x, y, mass, color, false);
    this.vx = vx;
    this.vy = vy;
  }
}

module.exports = EjectedEntity;