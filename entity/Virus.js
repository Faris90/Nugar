const CoreEntity = require('./CoreEntity');

class VirusEntity extends CoreEntity {
  constructor(id, x, y) {
    super(id, 'virus', x, y, 100, '#33cc33', true);
  }
}

module.exports = VirusEntity;