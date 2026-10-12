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

// 2. Extractor Directo (Loader / Savenow / LBServer)
async function resolverExtractorDirecto(videoUrl) {
  const dominios = [
    'https://p.savenow.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominios) {
    try {
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: 'mp3', url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
        timeout: 7000
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const pRes = await axios.get(progressUrl, {
          headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
          timeout: 7000
        });

        if (pRes.data && pRes.data.success === 1 && pRes.data.download_url) {
          console.log(`[Extractor Directo Éxito]: Resuelto enlace desde ${dominio}`);
          return pRes.data.download_url;
        }

        if (pRes.data && pRes.data.text && pRes.data.text.toLowerCase().includes('error')) {
          break;
        }
      }
    } catch (_) {}
  }
  return null;
}

// 3. Invidious / Piped Mirrors
async function resolverInvidiousPiped(videoId) {
  const invidiousHosts = [
    'https://invidious.f5.si',
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, { timeout: 5000, headers: { 'User-Agent': UA } });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Invidious Éxito]: Resuelto formato adaptativo desde ${host}`);
        return mejor.url;
      }
    } catch (_) {}
  }

  const pipedHosts = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.adminforge.de'
  ];

  for (const host of pipedHosts) {
    try {
      const r = await axios.get(`${host}/streams/${videoId}`, { timeout: 5000, headers: { 'User-Agent': UA } });
      const mejor = (r.data?.audioStreams || []).filter((a) => a.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (mejor && mejor.url) {
        console.log(`[Piped Éxito]: Resuelto audioStream desde ${host}`);
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
    const progresivo = trans.find((t) => t.format?.protocol === 'progressive')
      || trans.find((t) => t.format?.mime_type === 'audio/mpeg')
      || trans[0];

    if (!progresivo) return null;

    const streamInfo = await axios.get(progresivo.url, {
      params: { client_id: clientId },
      headers: { 'User-Agent': UA },
      timeout: 8000
    });

    if (streamInfo.data?.url) {
      console.log(`[SoundCloud Fallback Éxito]: Resuelta URL directa de CDN`);
      return streamInfo.data.url;
    }
  } catch (_) {}
  return null;
}

// Función maestra para resolver el enlace de descarga directa
async function resolverDirectAudioUrl(video, busqueda) {
  const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

  // Cascada de resolución:
  // 1. Cobalt
  let url = await resolverCobalt(videoUrl);
  if (url) return url;

  // 2. Extractor directo (Loader/savenow)
  url = await resolverExtractorDirecto(videoUrl);
  if (url) return url;

  // 3. Invidious / Piped
  url = await resolverInvidiousPiped(video.videoId);
  if (url) return url;

  // 4. SoundCloud Fallback CDN
  url = await resolverSoundCloud(busqueda, video.seconds);
  if (url) return url;

  return null;
}

// ---------------------------------------------------------------------------
// ENDPOINT 1: /api/obtener-enlace
// Devuelve JSON con titulo, artista, duracion y downloadUrl para descarga por cliente
// ---------------------------------------------------------------------------
app.get('/api/obtener-enlace', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de la canción en ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/obtener-enlace: "${busqueda}"`);

  try {
    // 1. Búsqueda oficial con yt-search
    const consultaBusqueda = `${busqueda} audio oficial`;
    const searchResult = await yts(consultaBusqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];

    const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
      || videos.find((v) => v.seconds > 60)
      || videos[0];

    if (!video) {
      return res.status(404).json({ error: 'No se encontró la canción oficial en YouTube.' });
    }

    const trackTitle = video.title || busqueda;
    const trackArtist = video.author ? video.author.name : '';
    const trackDuration = video.seconds || 0;

    console.log(`[Video Seleccionado]: "${trackTitle}" (${video.seconds}s)`);

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