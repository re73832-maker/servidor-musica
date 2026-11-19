const axios = require('axios');
const { Ytdl } = require('@distube/ytdl-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ytdlInstance = new Ytdl();

// Helper seguro para AbortSignal.timeout
function getTimeoutSignal(ms = 10000) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`Timeout de ${ms}ms alcanzado`)), ms).unref();
  return controller.signal;
}

// Normalizador de formato deseado
function normalizarFormato(formato) {
  if (!formato) return 'mp3';
  const f = formato.toLowerCase().trim();
  if (f === 'm4a') return 'm4a';
  if (f.includes('720') || f.includes('hd')) return '720';
  if (f.includes('1080')) return '1080';
  if (f.includes('360') || f.includes('240') || f.includes('144')) return '360';
  return 'mp3';
}

// ---------------------------------------------------------------------------
// NIVEL 1: SoundCloud Direct Progressive + HLS fMP4 Muxer (Funciona 100% en Render sin bloqueos)
// ---------------------------------------------------------------------------
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  try {
    const html = (await axios.get('https://soundcloud.com/', {
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000
    })).data;

    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('sndcdn.com'))
      .reverse();

    for (const src of scripts.slice(0, 6)) {
      try {
        const js = (await axios.get(src, {
          headers: { 'User-Agent': UA },
          signal: getTimeoutSignal(5000),
          timeout: 5000
        })).data;
        const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
        if (m) {
          scClientId = m[1];
          scClientIdFecha = Date.now();
          return scClientId;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/**
 * Descarga y ensambla una playlist HLS de SoundCloud (fMP4 AAC 160k o MP3) en un único Buffer de audio continuo
 */
async function ensamblarHlsSoundCloudABuffer(m3u8Url) {
  const m3u8Res = await axios.get(m3u8Url, {
    headers: { 'User-Agent': UA },
    signal: getTimeoutSignal(10000),
    timeout: 10000
  });

  const m3u8Text = String(m3u8Res.data || '');
  if (!m3u8Text.includes('#EXTM3U')) {
    throw new Error('Playlist M3U8 inválida');
  }

  const mapMatch = m3u8Text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const segUrls = m3u8Text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('http://') || l.startsWith('https://'));

  const todasLasUrls = mapMatch && mapMatch[1] ? [mapMatch[1], ...segUrls] : segUrls;
  if (todasLasUrls.length === 0) {
    throw new Error('Playlist M3U8 sin segmentos');
  }

  // Descargar segmentos en lotes paralelos de 8 para máxima velocidad (~1.5s total)
  const LOTE = 8;
  const buffers = [];
  for (let i = 0; i < todasLasUrls.length; i += LOTE) {
    const grupo = todasLasUrls.slice(i, i + LOTE);
    const descargados = await Promise.all(
      grupo.map((u) =>
        axios
          .get(u, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(12000),
            timeout: 12000
          })
          .then((r) => Buffer.from(r.data))
      )
    );
    buffers.push(...descargados);
  }

  const bufferCompleto = Buffer.concat(buffers);
  const esMp4 = Boolean(mapMatch && mapMatch[1]);
  return {
    buffer: bufferCompleto,
    mime: esMp4 ? 'audio/mp4' : 'audio/mpeg'
  };
}

async function probarSoundCloud(busqueda, duracionRef) {
  try {
    let clientId = await obtenerClientIdSoundCloud();
    if (!clientId) clientId = await obtenerClientIdSoundCloud(true);
    if (!clientId) return null;

    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 15 },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000,
      validateStatus: (status) => status === 200
    });

    const coleccion = (r.data?.collection || [])
      .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
      .filter((p) => p.full_duration >= 45000 && p.full_duration <= 900000);

    if (!coleccion.length) return null;

    // Filtrar pistas que tengan al menos un transcoding NO encriptado (progressive o hls estándar)
    const pistasReproducibles = coleccion.filter((p) => {
      const trans = p.media?.transcodings || [];
      return trans.some(
        (t) =>
          t.format?.protocol === 'progressive' ||
          (t.format?.protocol === 'hls' && !String(t.format?.mime_type || '').includes('mpegurl'))
      );
    });

    if (!pistasReproducibles.length) return null;

    if (duracionRef && duracionRef > 30) {
      const refMs = duracionRef * 1000;
      pistasReproducibles.sort((a, b) => {
        const aEsCover = /\b(cover|remix|karaoke|instrumental|tributo|parodia)\b/i.test(a.title || '');
        const bEsCover = /\b(cover|remix|karaoke|instrumental|tributo|parodia)\b/i.test(b.title || '');
        const scoreA = Math.abs(a.full_duration - refMs) + (aEsCover ? 45000 : 0);
        const scoreB = Math.abs(b.full_duration - refMs) + (bEsCover ? 45000 : 0);
        return scoreA - scoreB;
      });
    } else {
      pistasReproducibles.sort((a, b) => {
        const aEsCover = /\b(cover|remix|karaoke|instrumental|tributo|parodia)\b/i.test(a.title || '');
        const bEsCover = /\b(cover|remix|karaoke|instrumental|tributo|parodia)\b/i.test(b.title || '');
        return (aEsCover ? 1 : 0) - (bEsCover ? 1 : 0);
      });
    }

    // Recorrer pistas en orden de fidelidad (la canción original exacta primero, sea Progressive o HLS 160k)
    for (const pista of pistasReproducibles) {
      const trans = pista.media?.transcodings || [];

      // 1. Si esta pista tiene progressive directo, usarlo
      const progresivo = trans.find((t) => t.format?.protocol === 'progressive');
      if (progresivo) {
        try {
          const streamInfo = await axios.get(progresivo.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(6000),
            timeout: 6000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            console.log(`[SoundCloud Progressive Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s)`);
            return {
              url: streamInfo.data.url.replace(/^http:\/\//i, 'https://'),
              calidad: '160k',
              nivel: 1,
              proveedor: 'SoundCloud-Progressive'
            };
          }
        } catch (_) {}
      }

      // 2. Si esta pista tiene HLS estándar no encriptado (MP3 o fMP4 AAC 160k), usarlo
      const hlsMp3 = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mpeg') && !String(t.format?.mime_type || '').includes('mpegurl')
      );
      const hlsAac = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mp4')
      );
      const elegido = hlsMp3 || hlsAac;
      if (elegido) {
        try {
          const streamInfo = await axios.get(elegido.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(6000),
            timeout: 6000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            const m3u8Url = streamInfo.data.url.replace(/^http:\/\//i, 'https://');
            console.log(`[SoundCloud HLS Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s, ${elegido.format?.mime_type})`);
            return {
              url: m3u8Url,
              esHlsSoundCloud: true,
              calidad: '160k',
              nivel: 1,
              proveedor: 'SoundCloud-HLS'
            };
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('[SoundCloud Aviso]:', e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 2: Extractor nativo @distube/ytdl-core (Directo de YouTube)
// ---------------------------------------------------------------------------
async function resolverNativoYtdl(videoUrl) {
  try {
    console.log(`[Nivel 2 Nativo]: Extrayendo formatos con @distube/ytdl-core...`);
    const info = await Promise.race([
      ytdlInstance.getInfo(videoUrl, {
        requestOptions: {
          headers: { 'User-Agent': UA }
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ytdl.getInfo 8s')), 8000))
    ]);

    if (!info || !Array.isArray(info.formats) || info.formats.length === 0) {
      return null;
    }

    const audioFormats = info.formats.filter((f) => f.hasAudio && f.url);
    if (audioFormats.length === 0) return null;

    const audioOnly = audioFormats.filter((f) => !f.hasVideo);
    const lista = audioOnly.length > 0 ? audioOnly : audioFormats;

    lista.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const mejorFormato = lista[0];

    if (mejorFormato && mejorFormato.url) {
      const bitrate = mejorFormato.audioBitrate || 128;
      console.log(`[Nivel 2 Éxito]: Stream nativo resuelto (${bitrate} kbps)`);
      return {
        url: mejorFormato.url,
        calidad: `${bitrate}k`,
        nivel: 2,
        proveedor: 'ytdl-native-stream'
      };
    }
  } catch (err) {
    console.warn(`[Nivel 2 Aviso]: ytdl-core no pudo extraer enlace:`, err.message || err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 3: Loader / Savenow (Solo si no devuelve api_key_required)
// ---------------------------------------------------------------------------
async function probarLoaderSavenow(videoUrl, formato) {
  const dominios = [
    'https://p.savenow.to',
    'https://loader.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominios) {
    try {
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: formato, url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://en.loader.to/' },
        signal: getTimeoutSignal(5000),
        timeout: 5000,
        validateStatus: (status) => status === 200
      });

      if (!startRes.data || startRes.data.error_code === 'api_key_required' || !startRes.data.id) {
        break;
      }

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://en.loader.to/' },
            signal: getTimeoutSignal(4000),
            timeout: 4000,
            validateStatus: (status) => status === 200
          });

          const pData = pRes.data;
          if (!pData) continue;

          const downloadLink = pData.download_url || (pData.progress >= 1000 ? pData.url : null);
          if (
            downloadLink &&
            typeof downloadLink === 'string' &&
            downloadLink.length > 15 &&
            !downloadLink.includes('b.php') &&
            !downloadLink.includes('ey43.com') &&
            (pData.success === 1 || pData.success === true || pData.progress >= 1000 || pData.text === 'Finished')
          ) {
            const httpsLink = downloadLink.replace(/^http:\/\//i, 'https://');
            console.log(`[Nivel 3 Éxito]: Loader/Savenow (${dominio}) en intento ${i + 1}`);
            return {
              url: httpsLink,
              calidad: '320k',
              nivel: 3,
              proveedor: 'Loader.to'
            };
          }

          if (pData.text && pData.text.toLowerCase().includes('error')) break;
        } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA CON DEGRADACIÓN ELEGANTE ULTRA RÁPIDA
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const esYouTubeValido = video && video.videoId && video.videoId.length === 11 && !video.videoId.startsWith('itunes_');
  const videoUrl = esYouTubeValido ? `https://www.youtube.com/watch?v=${video.videoId}` : null;
  const duracionRef = video?.seconds || 0;
  const consultaCompleta = (busqueda || video?.title || '').trim();

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Resiliente]: Resolviendo "${video?.title || consultaCompleta}" (ID: ${video?.videoId}, Formato: ${formato})`);

  // 1. NIVEL 1: SoundCloud Progressive + HLS Muxer (Ultra rápido ~1.2s, inmune a bloqueos de IP de YouTube en Render)
  if (consultaCompleta) {
    try {
      const resSc = await Promise.race([
        probarSoundCloud(consultaCompleta, duracionRef),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SoundCloud Timeout 10s')), 10000))
      ]);
      if (resSc && resSc.url) {
        return resSc;
      }
    } catch (eSc) {
      console.warn(`[Nivel 1 SoundCloud]: Pasando a Nivel 2 (${eSc.message})`);
    }
  }

  // 2. NIVEL 2: Nativo @distube/ytdl-core (YouTube direct stream)
  if (videoUrl) {
    try {
      const res2 = await Promise.race([
        resolverNativoYtdl(videoUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 2 Timeout 8s')), 8000))
      ]);
      if (res2 && res2.url) {
        return res2;
      }
    } catch (e2) {
      console.warn(`[Nivel 2 YTDL]: Pasando a Nivel 3 (${e2.message})`);
    }
  }

  // 3. NIVEL 3: Savenow / Loader fallback
  if (videoUrl) {
    try {
      const res3 = await Promise.race([
        probarLoaderSavenow(videoUrl, formato),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 3 Timeout 8s')), 8000))
      ]);
      if (res3 && res3.url) {
        return res3;
      }
    } catch (e3) {
      console.warn(`[Nivel 3]: Falló (${e3.message})`);
    }
  }

  console.error(`[Cascada Agotada]: Todos los extractores fallaron para "${consultaCompleta}".`);
  return null;
}

module.exports = {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato,
  getTimeoutSignal
};
