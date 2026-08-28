const CoreEntity = require('./CoreEntity');

class PlayerCellEntity extends CoreEntity {
  constructor(id, x, y, mass, color, spawnProtectedUntil) {
    super(id, 'cell', x, y, mass, color, false);
    this.canMergeAfter = 0;
    this.spawnProtectedUntil = spawnProtectedUntil;
  }
}

module.exports = PlayerCellEntity;