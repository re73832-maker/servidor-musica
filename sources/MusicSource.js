/**
 * Interfaz común MusicSource para fuentes de audio en servidor-musica.
 * Todas las fuentes deben normalizar sus resultados a este formato.
 */
class MusicSource {
  constructor(name) {
    this.name = name || 'unknown';
  }

  isEnabled() {
    return true;
  }

  /**
   * @param {string} _query
   * @param {number} _limit
   * @returns {Promise<Array<object>>}
   */
  async search(_query, _limit = 15) {
    throw new Error(`${this.name}: search() no implementado`);
  }

  /**
   * @param {string} _id
   * @returns {Promise<{ downloadUrl: string, license?: string, author?: string } | null>}
   */
  async getStream(_id) {
    throw new Error(`${this.name}: getStream() no implementado`);
  }

  formatTimestamp(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}

module.exports = MusicSource;
