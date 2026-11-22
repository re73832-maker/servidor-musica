const yts = require('yt-search');
const axios = require('axios');
const MusicSource = require('./MusicSource');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class LegacyScraperSource extends MusicSource {
  constructor() {
    super('legacy_scraper');
  }

  isEnabled() {
    // Habilitado por defecto salvo que ENABLE_LEGACY_SCRAPERS=false
    return process.env.ENABLE_LEGACY_SCRAPERS !== 'false';
  }

  async search(busqueda) {
    if (!this.isEnabled()) return [];

    let videos = [];
    try {
      const searchResult = await yts(busqueda);
      if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
        videos = searchResult.videos;
      }
    } catch (e) {
      console.warn('[LegacyScraperSource yt-search falló]:', e.code || e.message);
    }

    if (!videos || videos.length === 0) {
      const invidiousHosts = [
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de',
        'https://yewtu.be',
        'https://invidious.jing.rocks'
      ];
      for (const host of invidiousHosts) {
        try {
          const resp = await axios.get(`${host}/api/v1/search`, {
            params: { q: busqueda, type: 'video' },
            timeout: 4000,
            headers: { 'User-Agent': UA }
          });
          if (Array.isArray(resp.data) && resp.data.length > 0) {
            videos = resp.data.map((item) => ({
              videoId: item.videoId,
              title: item.title,
              author: { name: item.author || '' },
              seconds: item.lengthSeconds || 0,
              timestamp: this.formatTimestamp(item.lengthSeconds || 0),
              thumbnail: item.videoThumbnails && item.videoThumbnails[0] ? item.videoThumbnails[0].url : ''
            }));
            break;
          }
        } catch (_) {}
      }
    }

    return (videos || [])
      .filter((v) => (v.seconds >= 40 && v.seconds <= 900) || (!v.seconds && v.timestamp))
      .slice(0, 15)
      .map((v) => {
        const author = v.author ? v.author.name || v.author : '';
        return {
          id: v.videoId,
          videoId: v.videoId,
          title: v.title,
          artist: author,
          author,
          license: 'Fuente externa (legacy)',
          seconds: v.seconds || 0,
          duration: v.timestamp || this.formatTimestamp(v.seconds || 0),
          timestamp: v.timestamp || this.formatTimestamp(v.seconds || 0),
          thumbnail: v.thumbnail || v.image || '',
          image: v.thumbnail || v.image || '',
          previewUrl: v.previewUrl || '',
          sourceVersion: 'legacy_scraper'
        };
      });
  }
}

module.exports = LegacyScraperSource;
