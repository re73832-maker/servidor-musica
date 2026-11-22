const axios = require('axios');
const MusicSource = require('./MusicSource');

class InternetArchiveSource extends MusicSource {
  constructor() {
    super('internet_archive');
  }

  isEnabled() {
    return true;
  }

  async search(query, limit = 12) {
    try {
      const q = `(${query}) AND mediatype:(audio) AND licenseurl:(*creativecommons* OR *publicdomain*)`;
      const resp = await axios.get('https://archive.org/advancedsearch.php', {
        params: {
          q,
          'fl[]': ['identifier', 'title', 'creator', 'licenseurl'],
          rows: limit,
          page: 1,
          output: 'json'
        },
        timeout: 8000
      });

      const docs = resp?.data?.response?.docs;
      if (!Array.isArray(docs) || docs.length === 0) return [];

      // Resolver archivo MP3/OGG de los primeros resultados en paralelo acotado
      const resultados = await Promise.all(
        docs.slice(0, 8).map(async (doc) => {
          if (!doc?.identifier) return null;
          const streamInfo = await this.getStream(doc.identifier, doc);
          if (!streamInfo) return null;

          const author = Array.isArray(doc.creator)
            ? doc.creator[0]
            : doc.creator || streamInfo.author || 'Internet Archive';
          const licenseUrl = doc.licenseurl || streamInfo.license || '';
          const license = licenseUrl.includes('publicdomain')
            ? 'Dominio Público'
            : licenseUrl
            ? `Creative Commons (${licenseUrl.replace(/^https?:\/\/creativecommons\.org\/licenses\//i, '').replace(/\/$/, '').toUpperCase()})`
            : 'Creative Commons (Internet Archive)';

          const seconds = streamInfo.seconds || 0;

          return {
            id: `ia:${doc.identifier}`,
            videoId: `ia:${doc.identifier}`,
            title: Array.isArray(doc.title) ? doc.title[0] : doc.title || doc.identifier,
            artist: author,
            author,
            license,
            seconds,
            duration: this.formatTimestamp(seconds),
            timestamp: this.formatTimestamp(seconds),
            thumbnail: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
            image: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
            streamUrl: streamInfo.downloadUrl,
            downloadUrl: streamInfo.downloadUrl,
            sourceVersion: 'internet_archive_cc'
          };
        })
      );

      return resultados.filter(Boolean);
    } catch (err) {
      console.warn('[InternetArchiveSource]: Error consultando archive.org:', err?.message || err);
      return [];
    }
  }

  async getStream(id, docMeta = null) {
    const identifier = String(id || '').replace(/^ia:/, '');
    if (!identifier) return null;

    try {
      const resp = await axios.get(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {
        timeout: 7000
      });
      const files = resp?.data?.files;
      if (!Array.isArray(files)) return null;

      const audioFile =
        files.find((f) => f?.name && /\.mp3$/i.test(f.name) && f.source !== 'metadata') ||
        files.find((f) => f?.name && /\.(ogg|flac|m4a)$/i.test(f.name) && f.source !== 'metadata');

      if (!audioFile) return null;

      const seconds = Math.round(Number(audioFile.length) || 0);
      const metadata = resp?.data?.metadata || {};
      const author = docMeta?.creator || metadata.creator || 'Internet Archive';
      const license = docMeta?.licenseurl || metadata.licenseurl || 'Creative Commons';

      return {
        downloadUrl: `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(audioFile.name)}`,
        seconds,
        author: Array.isArray(author) ? author[0] : author,
        license
      };
    } catch {
      return null;
    }
  }
}

module.exports = InternetArchiveSource;
