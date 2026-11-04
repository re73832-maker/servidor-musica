const axios = require('axios');
const { Ytdl } = require('@distube/ytdl-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ytdlInstance = new Ytdl();

// Helper seguro para AbortSignal.timeout (mínimo 60000ms por defecto)
function getTimeoutSignal(ms = 60000) {
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
// NIVEL 1: Extractores rápidos de alta calidad (320 kbps) - Timeout Inflexible 10s
// ---------------------------------------------------------------------------

// 1.1 Cobalt (con salto rápido si un mirror no responde)
async function probarCobalt(videoUrl) {
  const cobaltInstances = [
    'https://cobalt-api.kwiatekm.tokyo/',
    'https://api.cobalt.0011001100.xyz/',
    'https://cobalt.tools.api.alextesting.ninja/',
    'https://api.savefrom.net/',
    'https://cobalt-api.hyper.lol/',
    'https://api.cobalt.tools/'
  ];

  for (const cobaltUrl of cobaltInstances) {
    try {
      const cRes = await axios.post(cobaltUrl, {
        url: videoUrl,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': UA
        },
        signal: getTimeoutSignal(6000),
        timeout: 6000,
        validateStatus: (status) => status === 200
      });

      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        console.log(`[Nivel 1 Éxito]: Cobalt (${cobaltUrl})`);
        return {
          url: cRes.data.url.replace(/^http:\/\//i, 'https://'),
          calidad: '320k',
          nivel: 1,
          proveedor: 'Cobalt'
        };
      }
    } catch (e) {
      console.warn(`[Cobalt ${cobaltUrl} Falló]:`, e.name === 'CanceledError' || e.name === 'AbortError' ? 'Timeout' : e.message);
    }
  }
  return null;
}

// 1.2 Loader / Savenow (con polling de conversión extendido y timeout de 60s)
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
        signal: getTimeoutSignal(60000),
        timeout: 60000,
        validateStatus: (status) => status === 200
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      // Hasta 12 intentos de polling (unos 13 segundos de conversión)
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1100));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            signal: getTimeoutSignal(60000),
            timeout: 60000,
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

async function resolverNivel1(videoUrl, formato) {
  // Probar Cobalt primero con AbortSignal.timeout(10000)
  const resCobalt = await probarCobalt(videoUrl);
  if (resCobalt && resCobalt.url) return resCobalt;

  // Probar Loader/Savenow con AbortSignal.timeout(10000)
  const resLoader = await probarLoaderSavenow(videoUrl, formato);
  if (resLoader && resLoader.url) return resLoader;

  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 2: Proveedores secundarios con AbortSignal.timeout(10000) (Flujo Estándar 160k/128k)
// ---------------------------------------------------------------------------

// 2.1 Invidious / Piped Mirrors con AbortSignal.timeout(10000)
async function probarInvidious(videoId) {
  const invidiousHosts = [
    'https://invidious.jing.rocks',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.f5.si',
    'https://inv.tux.pizza',
    'https://iv.ggtyler.dev',
    'https://invidious.private.coffee'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, {
        signal: getTimeoutSignal(5000),
        timeout: 5000,
        headers: { 'User-Agent': UA },
        validateStatus: (status) => status === 200
      });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos.find((f) => String(f.itag) === '251') || formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Nivel 2 Éxito]: Invidious adaptativo (${host})`);
        return {
          url: mejor.url.replace(/^http:\/\//i, 'https://'),
          calidad: '160k',
          nivel: 2,
          proveedor: 'Invidious'
        };
      }
    } catch (e) {
      // Aborta y salta inmediatamente al siguiente host si no responde en 5s
    }
  }
  return null;
}

// 2.2 SoundCloud Progressive con AbortSignal.timeout(60000)
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  const html = (await axios.get('https://soundcloud.com/', {
    headers: { 'User-Agent': UA },
    signal: getTimeoutSignal(60000),
    timeout: 60000
  })).data;

  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .reverse();

  for (const src of scripts) {
    try {
      const js = (await axios.get(src, {
        headers: { 'User-Agent': UA },
        signal: getTimeoutSignal(60000),
        timeout: 60000
      })).data;
      const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
      if (m) {
        scClientId = m[1];
        scClientIdFecha = Date.now();
        return scClientId;
      }
    } catch (_) {}
  }
  throw new Error('SoundCloud client_id no disponible');
}

async function probarSoundCloud(busqueda, duracionRef) {
  try {
    let clientId = await obtenerClientIdSoundCloud();
    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 10 },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(60000),
      timeout: 60000,
      validateStatus: (status) => status === 200
    });

    const pistas = (r.data?.collection || [])
      .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
      .filter((p) => p.full_duration > 60000)
      .filter((p) => Math.abs(p.duration - p.full_duration) < 5000);

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
      signal: getTimeoutSignal(60000),
      timeout: 60000,
      validateStatus: (status) => status === 200
    });

    if (streamInfo.data?.url) {
      console.log(`[Nivel 2 Éxito]: SoundCloud Progressive`);
      return {
        url: streamInfo.data.url.replace(/^http:\/\//i, 'https://'),
        calidad: '160k',
        nivel: 2,
        proveedor: 'SoundCloud'
      };
    }
  } catch (_) {}
  return null;
}

async function resolverNivel2(videoId, busqueda, duracionRef) {
  if (videoId && videoId.length === 11 && !videoId.startsWith('itunes_')) {
    const invidiousRes = await probarInvidious(videoId);
    if (invidiousRes) return invidiousRes;
  }

  const scRes = await probarSoundCloud(busqueda, duracionRef);
  if (scRes) return scRes;

  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 3: Salvavidas definitivo / Inmune a caídas (Nativo @distube/ytdl-core)
// ---------------------------------------------------------------------------
async function resolverNivel3(videoUrl) {
  try {
    console.log(`[Nivel 3 Salvavidas]: Intentando extracción nativa con @distube/ytdl-core...`);
    
    // Timeout ampliado de 20s para ytdl.getInfo
    const info = await Promise.race([
      ytdlInstance.getInfo(videoUrl, {
        requestOptions: {
          headers: { 'User-Agent': UA }
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ytdl getInfo Timeout 20s')), 20000))
    ]);

    if (!info || !Array.isArray(info.formats) || info.formats.length === 0) {
      return null;
    }

    const audioFormats = info.formats.filter((f) => f.hasAudio && f.url);
    if (audioFormats.length === 0) return null;

    const audioOnly = audioFormats.filter((f) => !f.hasVideo);
    const lista = audioOnly.length > 0 ? audioOnly : audioFormats;

    // Ordenar por bitrate de audio descendente
    lista.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const mejorFormato = lista[0];

    if (mejorFormato && mejorFormato.url) {
      const bitrate = mejorFormato.audioBitrate || 128;
      console.log(`[Nivel 3 Éxito Total]: Stream nativo resuelto (${bitrate} kbps)`);
      return {
        url: mejorFormato.url,
        calidad: `${bitrate}k`,
        nivel: 3,
        proveedor: 'ytdl-native-stream'
      };
    }
  } catch (errYtdl) {
    console.warn(`[Nivel 3 Aviso]: ytdl-core no pudo extraer enlace:`, errYtdl.message || errYtdl);
  }
  return null;
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA CON DEGRADACIÓN ELEGANTE (DOWNGRADE TRANSPARENTE)
// Timeouts robustos mínimos de 60s en conjunto
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const esYouTubeValido = video && video.videoId && video.videoId.length === 11 && !video.videoId.startsWith('itunes_');
  const videoUrl = esYouTubeValido ? `https://www.youtube.com/watch?v=${video.videoId}` : null;
  const duracionRef = video.seconds || 0;

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada de Resiliencia]: Iniciando resolución para "${video.title || busqueda}" (ID: ${video.videoId}, Formato: ${formato})`);

  // 1. NIVEL 1: Convertidores de alta calidad (320k: Cobalt / Loader) con timeout de hasta 25s
  if (videoUrl) {
    try {
      console.log(`[Cascada Nivel 1]: Ejecutando extractores 320k (Cobalt / Loader)...`);
      const res1 = await Promise.race([
        resolverNivel1(videoUrl, formato),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1 Timeout 25s')), 25000))
      ]);

      if (res1 && res1.url) {
        console.log(`[Cascada Éxito Nivel 1]: Audio entregado ${res1.calidad} vía ${res1.proveedor}`);
        return res1;
      }
    } catch (e1) {
      console.warn(`[Cascada Nivel 1 Falló o Saturó (${e1.message})]: Aplicando DEGRADACIÓN ELEGANTE a flujo estándar (160k/128k)...`);
    }
  }

  // 2. NIVEL 2: Degradación Elegante a flujo estándar (160k/128k: Invidious / SoundCloud) con timeout de hasta 25s
  try {
    console.log(`[Cascada Nivel 2 - Downgrade Transparente]: Conmutando a proveedores secundarios (Invidious / SoundCloud)...`);
    const res2 = await Promise.race([
      resolverNivel2(esYouTubeValido ? video.videoId : null, busqueda, duracionRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 2 Timeout 25s')), 25000))
    ]);

    if (res2 && res2.url) {
      console.log(`[Cascada Completada - DOWNGRADE TRANSPARENTE EXITOSO]: Audio entregado ${res2.calidad} vía ${res2.proveedor}`);
      return res2;
    }
  } catch (e2) {
    console.warn(`[Cascada Nivel 2 Falló (${e2.message})]: Conmutando a Nivel 3 Salvavidas Nativo...`);
  }

  // 3. NIVEL 3: Salvavidas definitivo (@distube/ytdl-core nativo) con timeout de hasta 20s
  if (videoUrl) {
    try {
      console.log(`[Cascada Nivel 3 - Salvavidas Nativo]: Extrayendo stream nativo de YouTube...`);
      const res3 = await Promise.race([
        resolverNivel3(videoUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 3 Timeout 20s')), 20000))
      ]);

      if (res3 && res3.url) {
        console.log(`[Cascada Completada - SALVAVIDAS NATIVO]: Audio entregado ${res3.calidad} vía ${res3.proveedor}`);
        return res3;
      }
    } catch (e3) {
      console.warn(`[Cascada Nivel 3 Falló]: ${e3.message}`);
    }
  }

  console.error(`[Cascada Agotada]: Todos los niveles de extracción fallaron para "${busqueda}".`);
  return null;
}

  console.error(`[Cascada Agotada]: Todos los niveles de extracción fallaron para "${busqueda}".`);
  return null;
}

module.exports = {
  resolverAudioConCascada,
  normalizarFormato,
  getTimeoutSignal
};
