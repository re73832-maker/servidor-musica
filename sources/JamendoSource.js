const axios = require('axios');
const MusicSource = require('./MusicSource');

class JamendoSource extends MusicSource {
  constructor() {
    super('jamendo');
  }

  getClientId() {
    return (process.env.JAMENDO_CLIENT_ID || '').trim();
  }

  isEnabled() {
    return Boolean(this.getClientId());
  }

  async search(query, limit = 15) {
    const clientId = this.getClientId();
    if (!clientId) return [];

    try {
      const resp = await axios.get('https://api.jamendo.com/v3.0/tracks/', {
        params: {
          client_id: clientId,
          format: 'json',
          limit,
          search: query,
          include: 'licenses+musicinfo',
          audioformat: 'mp32'
        },
        timeout: 7000
      });

      const tracks = resp?.data?.results;
      if (!Array.isArray(tracks)) return [];

      return tracks
        .filter((t) => t && t.audio && Number(t.duration) > 15)
        .map((t) => {
          const seconds = Math.round(Number(t.duration) || 0);
          const author = t.artist_name || 'Artista Jamendo';
          const license = t.license_ccurl
            ? `Creative Commons (${t.license_ccurl.replace(/^https?:\/\/creativecommons\.org\/licenses\//i, '').replace(/\/$/, '').toUpperCase()})`
            : 'Creative Commons (Jamendo)';

          return {
            id: `jamendo:${t.id}`,
            videoId: `jamendo:${t.id}`,
            title: t.name || 'Sin título',
            artist: author,
            author,
            license,
            seconds,
            duration: this.formatTimestamp(seconds),
            timestamp: this.formatTimestamp(seconds),
            thumbnail: t.album_image || t.image || '',
            image: t.album_image || t.image || '',
            streamUrl: t.audio,
            downloadUrl: t.audiodownload || t.audio,
            sourceVersion: 'jamendo_cc'
          };
        });
    } catch (err) {
      console.warn('[JamendoSource]: Error consultando Jamendo API:', err?.message || err);
      return [];
    }
  }

  async getStream(id) {
    const clientId = this.getClientId();
    if (!clientId) return null;
    const rawId = String(id || '').replace(/^jamendo:/, '');
    if (!rawId) return null;

    try {
      const resp = await axios.get('https://api.jamendo.com/v3.0/tracks/', {
        params: {
          client_id: clientId,
          format: 'json',
          id: rawId,
          audioformat: 'mp32'
        },
        timeout: 7000
      });
      const track = resp?.data?.results?.[0];
      if (!track || !track.audio) return null;
      return {
        downloadUrl: track.audiodownload || track.audio,
        license: track.license_ccurl || 'Creative Commons (Jamendo)',
        author: track.artist_name || 'Artista Jamendo'
      };
    } catch {
      return null;
    }
  }
}

module.exports = JamendoSource;
