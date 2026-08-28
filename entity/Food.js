const CoreEntity = require('./CoreEntity');

class FoodEntity extends CoreEntity {
  constructor(id, x, y, color, mass = 5) {
    super(id, 'food', x, y, mass, color, false);
  }
}

module.exports = FoodEntity;