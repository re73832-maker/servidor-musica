const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST_FRONTEND = path.join(__dirname, '..', 'app-musica', 'dist');
const RUTA_DIST_LOCAL = path.join(__dirname, 'dist');
const RUTA_DIST = (fs.existsSync(RUTA_DIST_FRONTEND) && fs.existsSync(path.join(RUTA_DIST_FRONTEND, 'index.html')))
  ? RUTA_DIST_FRONTEND
  : RUTA_DIST_LOCAL;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Middleware y CORS abierto
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Titulo-Audio']
}));

app.use(express.json());

// Endpoint de chequeo de salud para Render
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    port: PUERTO,
    mode: 'client-direct-download + direct-link-resolver'
  });
});

// ---------------------------------------------------------------------------
// Extractores para resolver downloadUrl directa (MP3 / M4A)
// ---------------------------------------------------------------------------

// 1. Cobalt
async function resolverCobalt(videoUrl) {
  const cobaltInstances = [
    'https://cobalt-api.kwiatekm.tokyo/',
    'https://api.cobalt.0011001100.xyz/',
    'https://cobalt.tools.api.alextesting.ninja/',
    'https://api.savefrom.net/'
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
        timeout: 4500,
        validateStatus: () => true
      });

      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        console.log(`[Cobalt Éxito]: Resuelto enlace desde ${cobaltUrl}`);
        return cRes.data.url;
      }
    } catch (_) {}
  }
  return null;
}

// 2. Extractor Directo (Savenow / Loader / LBServer) -> MÁXIMA COMPATIBILIDAD Y PRIORIDAD
async function resolverExtractorDirecto(videoUrl) {
  const dominios = [
    'https://p.savenow.to',
    'https://loader.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominios) {
    try {
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: 'mp3', url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
        timeout: 15000
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      // Polling resiliente hasta 30 intentos (aprox 35 segundos)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1100));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            timeout: 10000
          });

          const downloadLink = pRes.data?.download_url || pRes.data?.url;
          if (downloadLink && (pRes.data?.success === 1 || pRes.data?.success === true || pRes.data?.progress >= 1000 || pRes.data?.text === 'Finished')) {
            console.log(`[Extractor Directo Éxito]: Resuelto enlace desde ${dominio}: ${downloadLink.substring(0, 70)}...`);
            return downloadLink;
          }

          if (pRes.data && pRes.data.text && pRes.data.text.toLowerCase().includes('error')) {
            console.warn(`[Extractor Directo]: Error en progreso (${dominio}): ${pRes.data.text}`);
            break;
          }
        } catch (pollErr) {
          console.warn(`[Aviso polling ${dominio}]: ${pollErr.code || pollErr.message}`);
        }
      }
    } catch (errDom) {
      console.warn(`[Fallo inicio extractor ${dominio}]:`, errDom.code || errDom.message);
    }
  }
  return null;
}

// 3. Invidious Mirrors
async function resolverInvidiousPiped(videoId) {
  const invidiousHosts = [
    'https://invidious.f5.si',
    'https://inv.tux.pizza',
    'https://invidious.jing.rocks',
    'https://yewtu.be'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, { timeout: 6000, headers: { 'User-Agent': UA } });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos.find((f) => String(f.itag) === '251') || formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Invidious Éxito]: Resuelto formato adaptativo desde ${host}`);
        return mejor.url;
      }
    } catch (_) {}
  }
  return null;
}

// 4. Fallback SoundCloud CDN
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  const html = (await axios.get('https://soundcloud.com/', { headers: { 'User-Agent': UA }, timeout: 8000 })).data;
  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .reverse();

  for (const src of scripts) {
    try {
      const js = (await axios.get(src, { headers: { 'User-Agent': UA }, timeout: 8000 })).data;
      const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
      if (m) {
        scClientId = m[1];
        scClientIdFecha = Date.now();
        return scClientId;
      }
    } catch (_) {}
  }
  throw new Error('SoundCloud: no se pudo obtener client_id');
}

async function resolverSoundCloud(busqueda, duracionRef) {
  try {
    let clientId = await obtenerClientIdSoundCloud();
    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 12 },
      headers: { 'User-Agent': UA },
      timeout: 8000
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
    // ACEPTAR ÚNICAMENTE PROTOCOLO PROGRESSIVE (NUNCA HLS / .M3U8)
    const progresivo = trans.find((t) => t.format?.protocol === 'progressive');

    if (!progresivo) return null;

    const streamInfo = await axios.get(progresivo.url, {
      params: { client_id: clientId },
      headers: { 'User-Agent': UA },
      timeout: 8000
    });

    if (streamInfo.data?.url) {
      console.log(`[SoundCloud Fallback Éxito]: Resuelta URL directa de audio progresivo`);
      return streamInfo.data.url;
    }
  } catch (_) {}
  return null;
}

// Función maestra para resolver el enlace de descarga directa
async function resolverDirectAudioUrl(video, busqueda) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

  // 1. Extractor directo (Loader / Savenow / LBServer) -> MÁXIMA VELOCIDAD Y PRIORIDAD
  let url = await resolverExtractorDirecto(videoUrl);
  if (url) return url;

  // 2. Invidious / Piped Mirrors
  url = await resolverInvidiousPiped(video.videoId);
  if (url) return url;

  // 3. Fallback SoundCloud CDN (SOLO AUDIO PROGRESIVO REAL, NUNCA PLAYLISTS M3U8)
  url = await resolverSoundCloud(busqueda, video.seconds);
  if (url) return url;

  // 4. Cobalt
  url = await resolverCobalt(videoUrl);
  if (url) return url;

  return null;
}

// ---------------------------------------------------------------------------
// ENDPOINT: /api/buscar-canciones
// Devuelve lista de canciones coincidentes para que el usuario elija cuál descargar
// ---------------------------------------------------------------------------
app.get('/api/buscar-canciones', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const busqueda = (req.query.q || '').trim();
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el texto de búsqueda en ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/buscar-canciones: "${busqueda}"`);

  let videos = [];

  // Intento 1: yt-search con reintentos
  for (let intento = 0; intento < 3; intento++) {
    try {
      const searchResult = await yts(busqueda);
      if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
        videos = searchResult.videos;
        break;
      }
    } catch (e) {
      console.warn(`[yt-search intento ${intento + 1} falló]:`, e.code || e.message);
      if (intento < 2) await new Promise((r) => setTimeout(r, 600));
    }
  }

  // Fallback Invidious si yt-search falló
  if (!videos || videos.length === 0) {
    const invidiousHosts = [
      'https://invidious.nerdvpn.de',
      'https://inv.nadeko.net',
      'https://yewtu.be'
    ];
    for (const host of invidiousHosts) {
      try {
        const resp = await axios.get(`${host}/api/v1/search`, {
          params: { q: busqueda, type: 'video' },
          timeout: 5000,
          headers: { 'User-Agent': UA }
        });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          videos = resp.data.map((item) => ({
            videoId: item.videoId,
            title: item.title,
            author: { name: item.author || '' },
            seconds: item.lengthSeconds || 0,
            timestamp: `${Math.floor((item.lengthSeconds || 0) / 60)}:${(item.lengthSeconds || 0) % 60 < 10 ? '0' : ''}${(item.lengthSeconds || 0) % 60}`,
            thumbnail: (item.videoThumbnails && item.videoThumbnails[0]) ? item.videoThumbnails[0].url : ''
          }));
          break;
        }
      } catch (_) {}
    }
  }

  // Filtrar canciones individuales (evitar mixes de 2 horas)
  const filtrados = videos
    .filter((v) => (v.seconds >= 40 && v.seconds <= 900) || (!v.seconds && v.timestamp))
    .slice(0, 25);

  const listaFinal = filtrados.length > 0 ? filtrados : videos.slice(0, 15);

  const resultados = listaFinal.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    artist: v.author ? (v.author.name || v.author) : '',
    timestamp: v.timestamp || `${Math.floor((v.seconds || 0) / 60)}:${(v.seconds || 0) % 60 < 10 ? '0' : ''}${(v.seconds || 0) % 60}`,
    seconds: v.seconds || 0,
    thumbnail: v.thumbnail || v.image || ''
  }));

  console.log(`[Resultados devueltos]: ${resultados.length} canciones para "${busqueda}"`);

  return res.json({
    consulta: busqueda,
    total: resultados.length,
    resultados
  });
});

// ---------------------------------------------------------------------------
// ENDPOINT 1: /api/obtener-enlace
// Devuelve JSON con titulo, artista, duracion y downloadUrl para descarga por cliente
// ---------------------------------------------------------------------------
app.get('/api/obtener-enlace', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();

  if (!busqueda && !videoId) {
    return res.status(400).json({ error: 'Debes enviar ?q= o ?videoId=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/obtener-enlace: "${busqueda}" (videoId: ${videoId || 'auto'})`);

  try {
    let video = null;

    if (videoId) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        title: busqueda,
        author: { name: artistaSugerido }
      };
    } else {
      // 1. Búsqueda oficial con yt-search con reintentos
      for (let i = 0; i < 3; i++) {
        try {
          const consultaBusqueda = `${busqueda} audio oficial`;
          const searchResult = await yts(consultaBusqueda);
          const videos = searchResult && searchResult.videos ? searchResult.videos : [];
          video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
            || videos.find((v) => v.seconds > 60)
            || videos[0];
          if (video) break;
        } catch (e) {
          if (i < 2) await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    if (!video) {
      return res.status(404).json({ error: 'No se encontró la canción oficial en YouTube.' });
    }

    const trackTitle = video.title || busqueda;
    const trackArtist = (video.author && video.author.name) ? video.author.name : artistaSugerido;
    const trackDuration = video.seconds || duracionSugerida || 0;

    console.log(`[Video Seleccionado]: "${trackTitle}" (${video.seconds}s, ID: ${video.videoId})`);

    // 2. Resolver enlace de descarga directa
    const downloadUrl = await resolverDirectAudioUrl(video, busqueda);

    if (!downloadUrl) {
      console.warn(`[Aviso]: No se pudo resolver la URL directa de audio para "${busqueda}".`);
      return res.status(502).json({
        error: 'No se pudo resolver el enlace de descarga directa de ningún proveedor.'
      });
    }

    console.log(`[Éxito]: Enlace entregado al cliente: ${downloadUrl.substring(0, 80)}...`);

    return res.json({
      titulo: trackTitle,
      artista: trackArtist,
      duracion: trackDuration,
      downloadUrl: downloadUrl
    });

  } catch (error) {
    console.error(`[Error /api/obtener-enlace]:`, error.message || error);
    return res.status(500).json({
      error: 'Error interno al procesar la resolución del enlace de audio.'
    });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/proxy-stream
// Proxy de streaming con CORS abierto para el navegador
// ---------------------------------------------------------------------------
app.get('/api/proxy-stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const audioUrl = req.query.url;
  if (!audioUrl) {
    return res.status(400).json({ error: 'Debes enviar el parámetro ?url=' });
  }

  console.log(`\n[/api/proxy-stream]: Transmitiendo stream para: ${audioUrl.substring(0, 80)}...`);

  let axiosStream = null;

  res.on('close', () => {
    if (axiosStream && typeof axiosStream.destroy === 'function') {
      axiosStream.destroy();
    }
  });

  try {
    const response = await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'Referer': 'https://loader.to/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      },
      validateStatus: () => true
    });

    if (response.status !== 200) {
      return res.status(response.status).json({
        error: `Servidor remoto devolvió HTTP ${response.status}`
      });
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('text/plain') ||
      contentTypeRemoto.includes('application/vnd.apple.mpegurl') ||
      contentTypeRemoto.includes('application/x-mpegurl') ||
      contentTypeRemoto.includes('application/json')
    ) {
      console.warn(`[/api/proxy-stream]: Servidor remoto no devolvió audio sino ${contentTypeRemoto}`);
      return res.status(502).json({
        error: 'El origen devolvió una respuesta no válida (HTML o playlist en vez de archivo de audio).'
      });
    }

    const stream = response.data;
    axiosStream = stream;

    const mime = (response.headers['content-type'] && response.headers['content-type'].startsWith('audio/'))
      ? response.headers['content-type']
      : 'audio/mpeg';

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    if (response.headers['content-disposition']) {
      res.setHeader('Content-Disposition', response.headers['content-disposition']);
    }

    stream.on('error', (err) => {
      console.error('[/api/proxy-stream Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Fallo al transmitir stream" });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);

  } catch (error) {
    console.error('[/api/proxy-stream Error Catch]:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'No se pudo conectar con el origen del archivo' });
    }
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/descargar-cancion
// Descarga directa completa en un solo paso: resuelve y transmite el stream de audio
// ---------------------------------------------------------------------------
app.get('/api/descargar-cancion', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Titulo-Audio');

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();

  if (!busqueda && !videoId) {
    return res.status(400).json({ error: 'Debes enviar ?q= o ?videoId=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/descargar-cancion: "${busqueda}" (videoId: ${videoId || 'auto'})`);

  try {
    let video = null;

    if (videoId) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        title: busqueda,
        author: { name: artistaSugerido }
      };
    } else {
      for (let i = 0; i < 3; i++) {
        try {
          const consultaBusqueda = `${busqueda} audio oficial`;
          const searchResult = await yts(consultaBusqueda);
          const videos = searchResult && searchResult.videos ? searchResult.videos : [];
          video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
            || videos.find((v) => v.seconds > 60)
            || videos[0];
          if (video) break;
        } catch (e) {
          if (i < 2) await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    if (!video) {
      return res.status(404).json({ error: 'No se encontró la canción en YouTube.' });
    }

    const trackTitle = video.title || busqueda;

    // 1. Resolver enlace de audio directo
    let downloadUrl = await resolverExtractorDirecto(videoUrl);
    let fallbackId = video.videoId;

    if (!downloadUrl) {
      downloadUrl = await resolverInvidiousPiped(video.videoId);
    }

    if (!downloadUrl) {
      return res.status(502).json({
        error: 'No se pudo generar el enlace de audio para este tema en este momento. Por favor reintenta.'
      });
    }

    console.log(`[Descarga Directa]: Transmitiendo audio desde: ${downloadUrl.substring(0, 80)}...`);

    // 2. Transmitir el stream directamente al cliente
    let response;
    try {
      response = await axios({
        method: 'get',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 60000,
        headers: {
          'Referer': 'https://loader.to/',
          'User-Agent': UA,
          'Accept': '*/*'
        },
        validateStatus: () => true
      });

      if (response.status !== 200 && fallbackId) {
        console.warn(`[Stream Primario HTTP ${response.status}]: Intentando fallback Invidious...`);
        const altUrl = await resolverInvidiousPiped(fallbackId);
        if (altUrl) {
          response = await axios({
            method: 'get',
            url: altUrl,
            responseType: 'stream',
            timeout: 60000,
            headers: { 'User-Agent': UA, 'Accept': '*/*' },
            validateStatus: () => true
          });
        }
      }
    } catch (errAxios) {
      if (fallbackId) {
        const altUrl = await resolverInvidiousPiped(fallbackId);
        if (altUrl) {
          response = await axios({
            method: 'get',
            url: altUrl,
            responseType: 'stream',
            timeout: 60000,
            headers: { 'User-Agent': UA, 'Accept': '*/*' },
            validateStatus: () => true
          });
        }
      }
      if (!response) throw errAxios;
    }

    if (response.status !== 200) {
      return res.status(response.status).json({
        error: `Servidor remoto devolvió HTTP ${response.status}`
      });
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('application/json') ||
      contentTypeRemoto.includes('application/vnd.apple.mpegurl') ||
      contentTypeRemoto.includes('application/x-mpegurl')
    ) {
      return res.status(502).json({
        error: 'El origen devolvió una respuesta no válida (HTML o playlist en vez de archivo de audio).'
      });
    }

    const mime = (response.headers['content-type'] && response.headers['content-type'].startsWith('audio/'))
      ? response.headers['content-type']
      : 'audio/mpeg';

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);

    let axiosStream = response.data;
    res.on('close', () => {
      if (axiosStream && typeof axiosStream.destroy === 'function') {
        axiosStream.destroy();
      }
    });

    axiosStream.on('error', (err) => {
      console.error('[/api/descargar-cancion Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Fallo al transmitir stream de audio" });
      } else {
        res.destroy();
      }
    });

    axiosStream.pipe(res);

  } catch (error) {
    console.error(`[Error /api/descargar-cancion]:`, error.message || error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Error interno al procesar la descarga de audio.'
      });
    }
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT 2: /descargar (Fallback de compatibilidad)
// ---------------------------------------------------------------------------
app.get('/descargar', async (req, res) => {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar ?q=' });
  }

  try {
    const consultaBusqueda = `${busqueda} audio oficial`;
    const searchResult = await yts(consultaBusqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];
    const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
      || videos.find((v) => v.seconds > 60)
      || videos[0];

    if (!video) {
      return res.status(404).json({ error: 'No se encontró el video oficial.' });
    }

    const downloadUrl = await resolverDirectAudioUrl(video, busqueda);
    if (!downloadUrl) {
      return res.status(502).json({ error: 'No se pudo obtener enlace de audio.' });
    }

    // Redireccionar al cliente directamente a la URL de descarga
    return res.redirect(302, downloadUrl);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Rutas de compatibilidad
app.get('/buscar', (req, res) => res.redirect(307, `/api/obtener-enlace?q=${encodeURIComponent(req.query.q || '')}`));
app.get('/stream', (req, res) => res.redirect(307, `/descargar?q=${encodeURIComponent(req.query.q || '')}`));

// Servir estáticos de la PWA compilada
app.use(express.static(RUTA_DIST));

// Fallback SPA/PWA
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }

  const archivoIndex = path.join(RUTA_DIST, 'index.html');
  if (fs.existsSync(archivoIndex)) {
    return res.sendFile(archivoIndex);
  }

  res.status(404).send('No se encontró el archivo index.html en dist');
});

if (require.main === module) {
  app.listen(PUERTO, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` Servidor Express Activo en Puerto ${PUERTO}`);
    console.log(` Endpoint Directo: GET /api/obtener-enlace?q=...`);
    console.log(` Descarga realizada directamente por el cliente`);
    console.log(` Aplicación web: http://localhost:${PUERTO}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;