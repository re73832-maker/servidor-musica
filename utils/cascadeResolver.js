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
// NIVEL 1: Loader / Savenow (320 kbps MP3 Directo de alta velocidad)
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
        headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
        signal: getTimeoutSignal(8000),
        timeout: 8000,
        validateStatus: (status) => status === 200
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      // Polling rápido cada 700ms (hasta 10 intentos = máx ~7 segundos)
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            signal: getTimeoutSignal(5000),
            timeout: 5000,
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
            console.log(`[Nivel 1 Éxito]: Loader/Savenow (${dominio}) en intento ${i + 1}`);
            return {
              url: httpsLink,
              calidad: '320k',
              nivel: 1,
              proveedor: 'Loader.to'
            };
          }

          if (pData.text && pData.text.toLowerCase().includes('error')) break;
        } catch (_) {}
      }
    } catch (e) {
      console.warn(`[Loader/Savenow ${dominio} Falló]:`, e.name === 'CanceledError' || e.name === 'AbortError' ? 'Timeout' : e.message);
    }
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ytdl.getInfo 10s')), 10000))
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
// NIVEL 3: SoundCloud Progressive (Fallback alternativo)
// ---------------------------------------------------------------------------
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  try {
    const html = (await axios.get('https://soundcloud.com/', {
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(10000),
      timeout: 10000
    })).data;

    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('sndcdn.com'))
      .reverse();

    for (const src of scripts.slice(0, 5)) {
      try {
        const js = (await axios.get(src, {
          headers: { 'User-Agent': UA },
          signal: getTimeoutSignal(6000),
          timeout: 6000
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

async function probarSoundCloud(busqueda, duracionRef) {
  try {
    const clientId = await obtenerClientIdSoundCloud();
    if (!clientId) return null;

    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 6 },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000,
      validateStatus: (status) => status === 200
    });

    const pistas = (r.data?.collection || [])
      .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
      .filter((p) => p.full_duration > 60000);

    if (!pistas.length) return null;

    let seleccionada = pistas[0];
    if (duracionRef) {
      const refMs = duracionRef * 1000;
      pistas.sort((a, b) => Math.abs(a.full_duration - refMs) - Math.abs(b.full_duration - refMs));
      seleccionada = pistas[0];
    }

    const trans = seleccionada.media?.transcodings || [];
    const progresivo = trans.find((t) => t.format?.protocol === 'progressive');
    if (!progresivo) return null;

    const streamInfo = await axios.get(progresivo.url, {
      params: { client_id: clientId },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000,
      validateStatus: (status) => status === 200
    });

    if (streamInfo.data?.url) {
      console.log(`[Nivel 3 Éxito]: SoundCloud Progressive`);
      return {
        url: streamInfo.data.url.replace(/^http:\/\//i, 'https://'),
        calidad: '160k',
        nivel: 3,
        proveedor: 'SoundCloud'
      };
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA CON DEGRADACIÓN ELEGANTE ULTRA RÁPIDA
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const esYouTubeValido = video && video.videoId && video.videoId.length === 11 && !video.videoId.startsWith('itunes_');
  const videoUrl = esYouTubeValido ? `https://www.youtube.com/watch?v=${video.videoId}` : null;
  const duracionRef = video.seconds || 0;

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Resiliente]: Resolviendo "${video.title || busqueda}" (ID: ${video.videoId}, Formato: ${formato})`);

  // 1. NIVEL 1: Savenow / Loader (320k direct MP3) - Tiempo límite 8s
  if (videoUrl) {
    try {
      const res1 = await Promise.race([
        probarLoaderSavenow(videoUrl, formato),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1 Timeout 8s')), 8000))
      ]);
      if (res1 && res1.url) {
        return res1;
      }
    } catch (e1) {
      console.warn(`[Nivel 1]: Pasando a Nivel 2 (${e1.message})`);
    }
  }

  // 2. NIVEL 2: Nativo @distube/ytdl-core (YouTube direct stream) - Tiempo límite 10s
  if (videoUrl) {
    try {
      const res2 = await Promise.race([
        resolverNativoYtdl(videoUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 2 Timeout 10s')), 10000))
      ]);
      if (res2 && res2.url) {
        return res2;
      }
    } catch (e2) {
      console.warn(`[Nivel 2]: Pasando a Nivel 3 (${e2.message})`);
    }
  }

  // 3. NIVEL 3: SoundCloud Progressive fallback - Tiempo límite 8s
  try {
    const res3 = await Promise.race([
      probarSoundCloud(busqueda, duracionRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 3 Timeout 8s')), 8000))
    ]);
    if (res3 && res3.url) {
      return res3;
    }
  } catch (e3) {
    console.warn(`[Nivel 3]: Falló (${e3.message})`);
  }

  console.error(`[Cascada Agotada]: Todos los extractores fallaron para "${busqueda}".`);
  return null;
}

module.exports = {
  resolverAudioConCascada,
  normalizarFormato,
  getTimeoutSignal
};
