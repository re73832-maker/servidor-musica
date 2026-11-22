const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_PUBLIC = path.join(__dirname, 'public');
const RUTA_DIST_LOCAL = path.join(__dirname, 'dist');
const RUTA_DIST_FRONTEND = path.join(__dirname, '..', 'app-musica', 'dist');

// Orden de resolución para la carpeta de archivos estáticos (OTA / PWA):
// 1. public/ en servidor-musica (para Render con frontend empaquetado)
// 2. dist/ en servidor-musica
// 3. ../app-musica/dist (para monorepo local en desarrollo)
const RUTA_ESTATICOS = (fs.existsSync(path.join(RUTA_PUBLIC, 'index.html')))
  ? RUTA_PUBLIC
  : (fs.existsSync(path.join(RUTA_DIST_LOCAL, 'index.html')))
    ? RUTA_DIST_LOCAL
    : (fs.existsSync(path.join(RUTA_DIST_FRONTEND, 'index.html')))
      ? RUTA_DIST_FRONTEND
      : RUTA_PUBLIC;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Middleware y CORS abierto
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Titulo-Audio']
}));

app.use(express.json());

// Compresión HTTP ligera (Brotli / Gzip) con zlib nativo para respuestas JSON, JS, CSS, HTML y SVG
app.use((req, res, next) => {
  const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();
  const supportsBr = acceptEncoding.includes('br');
  const supportsGzip = acceptEncoding.includes('gzip');
  if ((!supportsBr && !supportsGzip) || req.path.startsWith('/api/proxy-stream')) {
    return next();
  }

  const origSend = res.send.bind(res);
  res.send = (body) => {
    try {
      if (res.headersSent || !body) return origSend(body);
      const ct = String(res.getHeader('Content-Type') || '').toLowerCase();
      const esComprimible =
        typeof body === 'string' ||
        ct.includes('json') ||
        ct.includes('javascript') ||
        ct.includes('css') ||
        ct.includes('html') ||
        ct.includes('svg');
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      if (!esComprimible || buf.length < 1024) {
        return origSend(body);
      }
      res.setHeader('Vary', 'Accept-Encoding');
      if (supportsBr) {
        res.setHeader('Content-Encoding', 'br');
        res.removeHeader('Content-Length');
        return origSend(zlib.brotliCompressSync(buf));
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      return origSend(zlib.gzipSync(buf));
    } catch (_) {
      return origSend(body);
    }
  };
  next();
});

// Endpoint de chequeo de salud para Render y detección OTA automática
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    version: 'v4.1.0 Oficial 🚀',
    cacheVersion: 'app-musica-v4.1.0',
    port: PUERTO,
    mode: 'client-direct-download + direct-link-resolver'
  });
});

// ---------------------------------------------------------------------------
// ENDPOINT: POST /api/spotify/playlist
// Extrae metadatos (título, artista, carátula, duración) de una playlist pública
// de Spotify desde https://open.spotify.com/embed/playlist/${playlistId} sin API Keys
// ---------------------------------------------------------------------------
function extraerPlaylistIdSpotify(inputUrl = '') {
  const limpio = String(inputUrl || '').trim();
  if (!limpio) return null;
  const matchUri = limpio.match(/spotify:playlist:([a-zA-Z0-9]{15,35})/i);
  if (matchUri && matchUri[1]) return matchUri[1];
  const matchUrl = limpio.match(/playlist\/([a-zA-Z0-9]{15,35})/i);
  if (matchUrl && matchUrl[1]) return matchUrl[1];
  if (/^[a-zA-Z0-9]{22}$/.test(limpio)) return limpio;
  return null;
}

function decodificarHtmlEntities(str = '') {
  return String(str || '')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

app.post('/api/spotify/playlist', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const rawUrl = (req.body && req.body.url) ? String(req.body.url).trim() : '';
  const playlistId = extraerPlaylistIdSpotify(rawUrl);

  if (!playlistId) {
    return res.status(400).json({
      error: true,
      mensaje: 'Enlace de Spotify inválido. Pega un enlace válido como https://open.spotify.com/playlist/...'
    });
  }

  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const publicUrl = `https://open.spotify.com/playlist/${playlistId}`;

  console.log(`\n[/api/spotify/playlist]: Analizando playlist ID: ${playlistId}`);

  try {
    let nombrePlaylist = 'Playlist de Spotify';
    let caratulaPlaylist = '';
    const cancionesExtraidas = [];
    const vistos = new Set();

    const agregarCancionUnica = (title, artist, thumbnail, durationMs = 0, trackId = '') => {
      const tLimpio = decodificarHtmlEntities(title);
      const aLimpio = decodificarHtmlEntities(artist);
      if (!tLimpio) return;
      const clave = `${tLimpio.toLowerCase()}:::${aLimpio.toLowerCase()}`;
      if (vistos.has(clave)) return;
      vistos.add(clave);
      const seconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;
      const mins = Math.floor(seconds / 60);
      const rem = seconds % 60;
      cancionesExtraidas.push({
        id: trackId || `sp_${playlistId}_${cancionesExtraidas.length + 1}`,
        title: tLimpio,
        artist: aLimpio || 'Spotify Artist',
        thumbnail: thumbnail || caratulaPlaylist || '',
        seconds,
        timestamp: seconds > 0 ? `${mins}:${rem < 10 ? '0' : ''}${rem}` : '3:30'
      });
    };

    // 1. Consultar la vista embed oficial de Spotify (sin API Keys)
    let htmlEmbed = '';
    try {
      const respEmbed = await axios.get(embedUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        signal: AbortSignal.timeout(12000),
        timeout: 12000
      });
      htmlEmbed = typeof respEmbed.data === 'string' ? respEmbed.data : '';
    } catch (eEmbed) {
      console.warn('[/api/spotify/playlist]: Aviso al consultar embed:', eEmbed.message);
    }

    // 1.A. Parsear __NEXT_DATA__ en la vista embed
    if (htmlEmbed) {
      const matchNextData = htmlEmbed.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (matchNextData && matchNextData[1]) {
        try {
          const nextJson = JSON.parse(matchNextData[1]);
          const entity =
            nextJson?.props?.pageProps?.state?.data?.entity ||
            nextJson?.props?.pageProps?.entity ||
            nextJson?.props?.pageProps?.state?.data?.playlist ||
            null;

          if (entity) {
            if (entity.name || entity.title) {
              nombrePlaylist = decodificarHtmlEntities(entity.name || entity.title);
            }
            const coverImg =
              entity.coverArt?.sources?.[0]?.url ||
              entity.images?.[0]?.url ||
              entity.visualIdentity?.image?.[0]?.url ||
              '';
            if (coverImg) caratulaPlaylist = coverImg;

            const trackList =
              entity.trackList ||
              entity.tracks?.items ||
              [];

            if (Array.isArray(trackList)) {
              for (const item of trackList) {
                const trackObj = item?.track || item?.itemV2?.data || item;
                if (!trackObj) continue;
                const tTitle = trackObj.title || trackObj.name || '';
                const tArtist =
                  trackObj.subtitle ||
                  (Array.isArray(trackObj.artists)
                    ? trackObj.artists.map((a) => a.name || a.title || '').filter(Boolean).join(', ')
                    : '') ||
                  (Array.isArray(trackObj.artists?.items)
                    ? trackObj.artists.items.map((a) => a.profile?.name || a.name || '').filter(Boolean).join(', ')
                    : '');
                const tThumb =
                  trackObj.album?.images?.[0]?.url ||
                  trackObj.albumOfTrack?.coverArt?.sources?.[0]?.url ||
                  trackObj.coverArt?.sources?.[0]?.url ||
                  trackObj.imageUrl ||
                  caratulaPlaylist ||
                  '';
                const tDur = trackObj.duration || trackObj.duration_ms || trackObj.trackDuration?.totalMilliseconds || 0;
                const tUri = trackObj.uri || trackObj.id || '';
                agregarCancionUnica(tTitle, tArtist, tThumb, tDur, tUri);
              }
            }
          }
        } catch (errJson) {
          console.warn('[/api/spotify/playlist]: Error parseando __NEXT_DATA__:', errJson.message);
        }
      }

      // 1.B. Fallback: Parsear initial-state base64 si existe
      if (cancionesExtraidas.length === 0) {
        const matchInitState = htmlEmbed.match(/<script id="initial-state"[^>]*>([\s\S]*?)<\/script>/i);
        if (matchInitState && matchInitState[1]) {
          try {
            const decoded = Buffer.from(matchInitState[1].trim(), 'base64').toString('utf8');
            const stateJson = JSON.parse(decoded);
            const entities = stateJson?.entities?.items || {};
            for (const key of Object.keys(entities)) {
              const plObj = entities[key];
              if (plObj?.name) nombrePlaylist = plObj.name;
              const items = plObj?.content?.items || plObj?.tracks?.items || [];
              for (const it of items) {
                const tr = it?.itemV2?.data || it?.track || it;
                if (!tr) continue;
                const tTitle = tr.name || tr.title || '';
                const tArtist = (tr.artists?.items || tr.artists || [])
                  .map((a) => a?.profile?.name || a?.name || '')
                  .filter(Boolean)
                  .join(', ');
                const tThumb =
                  tr.albumOfTrack?.coverArt?.sources?.[0]?.url ||
                  tr.album?.images?.[0]?.url ||
                  caratulaPlaylist ||
                  '';
                const tDur = tr.trackDuration?.totalMilliseconds || tr.duration_ms || 0;
                agregarCancionUnica(tTitle, tArtist, tThumb, tDur, tr.uri || tr.id || '');
              }
            }
          } catch (_) {}
        }
      }

      // 1.C. Fallback Regex directo sobre JSON embebido en el HTML del embed
      if (cancionesExtraidas.length === 0) {
        const regexTrackList = /"title"\s*:\s*"((?:[^"\\]|\\.)+)"\s*,\s*"subtitle"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
        let m;
        while ((m = regexTrackList.exec(htmlEmbed)) !== null) {
          try {
            const t = JSON.parse(`"${m[1]}"`);
            const a = JSON.parse(`"${m[2]}"`);
            if (t && a && t.toLowerCase() !== nombrePlaylist.toLowerCase()) {
              agregarCancionUnica(t, a, caratulaPlaylist, 0);
            }
          } catch (_) {}
        }
      }
    }

    // 2. Si el embed no trajo todas o falló, intentar con la vista pública de open.spotify.com/playlist/${playlistId}
    if (cancionesExtraidas.length === 0) {
      try {
        const respPublic = await axios.get(publicUrl, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          signal: AbortSignal.timeout(10000),
          timeout: 10000
        });
        const htmlPub = typeof respPublic.data === 'string' ? respPublic.data : '';
        if (htmlPub) {
          const ogTitle = htmlPub.match(/<meta property="og:title" content="([^"]+)"/i);
          if (ogTitle && ogTitle[1]) nombrePlaylist = decodificarHtmlEntities(ogTitle[1]);
          const ogImg = htmlPub.match(/<meta property="og:image" content="([^"]+)"/i);
          if (ogImg && ogImg[1]) caratulaPlaylist = ogImg[1];

          const trackMetaRegex = /"name"\s*:\s*"((?:[^"\\]|\\.)+)"[^}]{0,300}"artists"\s*:\s*\[\s*\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
          let mPub;
          while ((mPub = trackMetaRegex.exec(htmlPub)) !== null) {
            try {
              const t = JSON.parse(`"${mPub[1]}"`);
              const a = JSON.parse(`"${mPub[2]}"`);
              agregarCancionUnica(t, a, caratulaPlaylist, 0);
            } catch (_) {}
          }
        }
      } catch (ePub) {
        console.warn('[/api/spotify/playlist]: Aviso en vista pública:', ePub.message);
      }
    }

    if (cancionesExtraidas.length === 0) {
      return res.status(404).json({
        error: true,
        mensaje: 'No se pudieron encontrar canciones en esa playlist. Verifica que la playlist de Spotify sea pública.'
      });
    }

    console.log(`[/api/spotify/playlist Éxito]: "${nombrePlaylist}" -> ${cancionesExtraidas.length} canciones extraídas`);

    return res.json({
      ok: true,
      playlistId,
      nombre: nombrePlaylist,
      caratula: caratulaPlaylist || (cancionesExtraidas[0] && cancionesExtraidas[0].thumbnail) || '',
      total: cancionesExtraidas.length,
      canciones: cancionesExtraidas
    });
  } catch (error) {
    console.error('[Error /api/spotify/playlist]:', error.message || error);
    return res.status(500).json({
      error: true,
      mensaje: 'Error al analizar la playlist de Spotify. Intenta nuevamente.'
    });
  }
});

// ---------------------------------------------------------------------------
// Extractores para resolver downloadUrl directa (MP3 / M4A)
// ---------------------------------------------------------------------------

// 1. Cobalt con AbortSignal.timeout(10000)
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
        signal: AbortSignal.timeout(10000),
        timeout: 10000,
        validateStatus: () => true
      });

      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        console.log(`[Cobalt Éxito]: Resuelto enlace desde ${cobaltUrl}`);
        return cRes.data.url;
      }
    } catch (_) {
      // Aborta y salta inmediatamente al siguiente si no responde en 10s
    }
  }
  return null;
}

// Normalizador inteligente de formatos soportados por el motor de descarga
function normalizarFormato(formato) {
  if (!formato) return 'mp3';
  const f = formato.toLowerCase().trim();
  if (f === 'm4a') return 'm4a';
  if (f.includes('720') || f.includes('hd')) return '720';
  if (f.includes('1080')) return '1080';
  if (f.includes('360') || f.includes('240') || f.includes('144')) return '360';
  return 'mp3';
}

// 1. Extractor Directo Ultra Rápido (Savenow / Loader) con AbortSignal.timeout(10000)
async function resolverExtractorDirecto(videoUrl, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
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
        signal: AbortSignal.timeout(10000),
        timeout: 10000
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      // Polling inteligente cada 900ms respetando AbortSignal.timeout(10000)
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 900));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            signal: AbortSignal.timeout(10000),
            timeout: 10000
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
            console.log(`[Extractor Directo Éxito (${formato})]: Resuelto en intento ${i + 1} desde ${dominio} -> ${httpsLink.substring(0, 75)}...`);
            return httpsLink;
          }

          if (pData.text && pData.text.toLowerCase().includes('error')) {
            console.warn(`[Extractor Directo]: Error en progreso (${dominio}): ${pData.text}`);
            break;
          }
        } catch (_) {}
      }
    } catch (errDom) {
      console.warn(`[Aviso extractor ${dominio}]:`, errDom.message || errDom);
    }
  }
  return null;
}

// 2. Invidious Mirrors con AbortSignal.timeout(10000) (Fallback secundario estándar 160k/128k)
async function resolverInvidiousPiped(videoId) {
  const invidiousHosts = [
    'https://invidious.jing.rocks',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.f5.si',
    'https://inv.tux.pizza'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(10000),
        timeout: 10000,
        headers: { 'User-Agent': UA }
      });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos.find((f) => String(f.itag) === '251') || formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Invidious Éxito]: Resuelto formato adaptativo desde ${host}`);
        return mejor.url;
      }
    } catch (_) {
      // Aborta en 10s y salta inmediatamente al siguiente
    }
  }
  return null;
}

// 3. Fallback SoundCloud CDN con AbortSignal.timeout(10000)
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  const html = (await axios.get('https://soundcloud.com/', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10000),
    timeout: 10000
  })).data;
  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .reverse();

  for (const src of scripts) {
    try {
      const js = (await axios.get(src, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
        timeout: 10000
      })).data;
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
      signal: AbortSignal.timeout(10000),
      timeout: 10000
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
      signal: AbortSignal.timeout(10000),
      timeout: 10000
    });

    if (streamInfo.data?.url) {
      console.log(`[SoundCloud Fallback Éxito]: Resuelta URL directa de audio progresivo`);
      return streamInfo.data.url;
    }
  } catch (_) {}
  return null;
}

const {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato: normalizarFormatoCascada,
  buscarVideoOriginalEnYouTube,
  construirConsultasOriginalYRescate
} = require('./utils/cascadeResolver');

// Función maestra para resolver el enlace de descarga directa con soporte de formatos (Cascada de 3 niveles)
async function resolverDirectAudioUrl(video, busqueda, formatoDeseado = 'mp3') {
  const res = await resolverAudioConCascada(video, busqueda, formatoDeseado);
  return res ? res.url : null;
}

// Cache de búsquedas en memoria (15 minutos de persistencia) para velocidad instantánea
const cacheBusquedaCanciones = new Map();

// Helper universal para localizar video en YouTube con filtro estricto anti-covers y duración ±18s
async function buscarVideoEnYouTube(busqueda, artista = '', duracionRefSegs = 0) {
  const videoOriginal = await buscarVideoOriginalEnYouTube(busqueda, artista, duracionRefSegs);
  if (videoOriginal) return videoOriginal;
  return null;
}

// ---------------------------------------------------------------------------
// ENDPOINT: /api/buscar-canciones
// Devuelve lista de canciones coincidentes de forma ultra rápida
// ---------------------------------------------------------------------------
app.get('/api/buscar-canciones', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const busqueda = (req.query.q || '').trim();
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el texto de búsqueda en ?q=' });
  }

  const claveCache = busqueda.toLowerCase();
  const cached = cacheBusquedaCanciones.get(claveCache);
  if (cached && (Date.now() - cached.timestamp < 15 * 60 * 1000)) {
    console.log(`[Cache Hit /api/buscar-canciones]: "${busqueda}" (${cached.resultados.length} canciones)`);
    return res.json({
      consulta: busqueda,
      total: cached.resultados.length,
      resultados: cached.resultados
    });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/buscar-canciones: "${busqueda}"`);

  let videos = [];

  try {
    const searchResult = await yts(busqueda);
    if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
      videos = searchResult.videos;
    }
  } catch (e) {
    console.warn(`[yt-search falló]:`, e.code || e.message);
  }

  // Fallback 1: Invidious si yt-search falló
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
            timestamp: `${Math.floor((item.lengthSeconds || 0) / 60)}:${(item.lengthSeconds || 0) % 60 < 10 ? '0' : ''}${(item.lengthSeconds || 0) % 60}`,
            thumbnail: (item.videoThumbnails && item.videoThumbnails[0]) ? item.videoThumbnails[0].url : ''
          }));
          break;
        }
      } catch (_) {}
    }
  }

  // Fallback 2: iTunes Search API oficial (Alta resiliencia sin bloqueo)
  if (!videos || videos.length === 0) {
    try {
      const itunesRes = await axios.get('https://itunes.apple.com/search', {
        params: { term: busqueda, media: 'music', entity: 'song', limit: 25 },
        timeout: 5000,
        headers: { 'User-Agent': UA }
      });
      if (itunesRes.data && Array.isArray(itunesRes.data.results) && itunesRes.data.results.length > 0) {
        videos = itunesRes.data.results.map((item) => {
          const seg = Math.round((item.trackTimeMillis || 0) / 1000);
          const min = Math.floor(seg / 60);
          const rem = seg % 60;
          return {
            videoId: `itunes_${item.trackId}`,
            title: item.trackName || '',
            author: { name: item.artistName || '' },
            seconds: seg,
            timestamp: `${min}:${rem < 10 ? '0' : ''}${rem}`,
            thumbnail: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: item.previewUrl || ''
          };
        });
      }
    } catch (eItunes) {
      console.warn('[iTunes search falló]:', eItunes.message);
    }
  }

  // Filtrar canciones individuales (evitar mixes de 2 horas)
  const filtrados = (videos || [])
    .filter((v) => (v.seconds >= 40 && v.seconds <= 900) || (!v.seconds && v.timestamp))
    .slice(0, 25);

  const listaFinal = filtrados.length > 0 ? filtrados : (videos || []).slice(0, 15);

  const resultados = listaFinal.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    artist: v.author ? (v.author.name || v.author) : '',
    timestamp: v.timestamp || `${Math.floor((v.seconds || 0) / 60)}:${(v.seconds || 0) % 60 < 10 ? '0' : ''}${(v.seconds || 0) % 60}`,
    seconds: v.seconds || 0,
    thumbnail: v.thumbnail || v.image || '',
    previewUrl: v.previewUrl || ''
  }));

  // Guardar en cache para respuestas inmediatas posteriores
  if (cacheBusquedaCanciones.size > 200) {
    const primeraClave = cacheBusquedaCanciones.keys().next().value;
    cacheBusquedaCanciones.delete(primeraClave);
  }
  cacheBusquedaCanciones.set(claveCache, { timestamp: Date.now(), resultados });

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
const { streamCacheMiddleware } = require('./middlewares/streamCache');
app.use('/api/obtener-enlace', streamCacheMiddleware);

app.get('/api/obtener-enlace', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  let respondido = false;
  const timeoutGuard = setTimeout(() => {
    if (!respondido && !res.headersSent) {
      respondido = true;
      return res.status(504).json({
        error: true,
        mensaje: 'Audio no disponible temporalmente (Tiempo de espera agotado >60s)'
      });
    }
  }, 65000);

  const finalizar = (status, payload) => {
    clearTimeout(timeoutGuard);
    if (!respondido && !res.headersSent) {
      respondido = true;
      return res.status(status).json(payload);
    }
  };

  req.on('close', () => {
    clearTimeout(timeoutGuard);
  });

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();
  const formatoDeseado = (req.query.formato || req.query.calidad || req.query.format || 'mp3').toLowerCase().trim();

  if (!busqueda && !videoId) {
    return finalizar(400, { error: true, mensaje: 'Debes enviar ?q= o ?videoId=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/obtener-enlace: "${busqueda}" (videoId: ${videoId || 'auto'})`);

  try {
    let video = null;

    if (videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido }
      };
    } else {
      video = await buscarVideoEnYouTube(busqueda, artistaSugerido, duracionSugerida);
      if (video) {
        video.duracionRef = duracionSugerida || video.seconds || 0;
        video.tituloOriginal = busqueda;
        video.artistaOriginal = artistaSugerido;
      }
    }

    if (!video) {
      return finalizar(404, { error: true, mensaje: 'Audio oficial no disponible' });
    }

    const trackTitle = video.title || busqueda;
    const trackArtist = (video.author && video.author.name) ? video.author.name : artistaSugerido;
    const trackDuration = video.seconds || duracionSugerida || 0;

    console.log(`[Video Seleccionado]: "${trackTitle}" (${video.seconds}s, ID: ${video.videoId})`);

    // 2. Resolver enlace con la cascada oficial de estudio (Prohibido covers de relleno)
    const resultadoAudio = await resolverAudioConCascada(video, busqueda, formatoDeseado);

    if (!resultadoAudio || !resultadoAudio.url) {
      console.warn(`[Aviso Cascada Oficial]: Audio oficial no disponible para "${busqueda}".`);
      return finalizar(404, {
        error: true,
        mensaje: 'Audio oficial no disponible'
      });
    }

    let downloadUrlFinal = resultadoAudio.url;
    if (
      resultadoAudio.esHlsSoundCloud ||
      (resultadoAudio.proveedor === 'ytdl-native-stream' && downloadUrlFinal.includes('googlevideo.com'))
    ) {
      downloadUrlFinal = `/api/proxy-stream?url=${encodeURIComponent(downloadUrlFinal)}`;
    }

    console.log(`[Éxito Cascada]: Enlace entregado al cliente (${resultadoAudio.calidad} / ${resultadoAudio.proveedor}): ${downloadUrlFinal.substring(0, 80)}...`);

    return finalizar(200, {
      titulo: trackTitle,
      artista: trackArtist,
      duracion: trackDuration,
      downloadUrl: downloadUrlFinal,
      calidad: resultadoAudio.calidad,
      proveedor: resultadoAudio.proveedor
    });

  } catch (error) {
    console.error(`[Error /api/obtener-enlace]:`, error.message || error);
    return finalizar(500, {
      error: true,
      mensaje: 'Audio no disponible temporalmente'
    });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/proxy-stream
// Proxy de streaming con CORS abierto para el navegador y resolución de pista completa
// ---------------------------------------------------------------------------
app.get('/api/proxy-stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');

  let audioUrl = (req.query.url || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const busqueda = (req.query.q || '').trim();

  // Si no se proporciona URL directa pero sí videoId o q, resolver la pista completa
  if (!audioUrl && (videoId || busqueda)) {
    try {
      let video = null;
      if (videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
        video = { videoId, title: busqueda, seconds: parseInt(req.query.seconds) || 0 };
      } else if (busqueda) {
        video = await buscarVideoEnYouTube(busqueda);
      }

      if (video) {
        const formato = (req.query.formato || 'mp3').toLowerCase();
        const resCascada = await resolverAudioConCascada(video, busqueda || video.title, formato);
        if (resCascada && resCascada.url) {
          audioUrl = resCascada.url;
          console.log(`[/api/proxy-stream]: Audio completo resuelto vía ${resCascada.proveedor}`);
        }
      }
    } catch (errRes) {
      console.warn('[/api/proxy-stream Error al resolver pista completa]:', errRes.message);
    }
  }

  // Rechazar fragmentos o URLs de preview de 30 segundos solo si NO es una solicitud explícita de vista previa
  const esPeticionPreview = req.query.tipo === 'preview' || req.query.preview === 'true';
  if (!esPeticionPreview && audioUrl && (audioUrl.includes('audio-preview') || audioUrl.includes('m4a-preview') || audioUrl.includes('itunes.apple.com'))) {
    return res.status(403).json({ error: 'Las pistas de vista previa de 30 segundos están deshabilitadas para descarga final' });
  }

  if (!audioUrl) {
    return res.status(400).json({ error: 'Debes enviar el parámetro ?url= o ?videoId= o ?q=' });
  }

  // Forzar siempre https para evitar bloqueos por Mixed Active Content
  audioUrl = audioUrl.replace(/^http:\/\//i, 'https://');

  console.log(`\n[/api/proxy-stream]: Transmitiendo stream completo para: ${audioUrl.substring(0, 80)}...`);

  let axiosStream = null;

  res.on('close', () => {
    if (axiosStream && typeof axiosStream.destroy === 'function') {
      axiosStream.destroy();
    }
  });

  const headersAxios = {
    'Referer': 'https://loader.to/',
    'User-Agent': UA,
    'Accept': '*/*'
  };
  if (req.headers.range) {
    headersAxios['Range'] = req.headers.range;
  }

  // Petición con soporte de reintento automático y timeout mínimo de 60 segundos
  const intentarProxy = async (esReintento = false) => {
    return await axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream',
      timeout: 60000,
      headers: headersAxios,
      maxRedirects: 5,
      validateStatus: () => true
    });
  };

  try {
    let response = null;
    try {
      response = await intentarProxy(false);
    } catch (eInicial) {
      console.warn(`[/api/proxy-stream]: Intento 1 falló (${eInicial.message}), aplicando reintento automático...`);
      await new Promise((r) => setTimeout(r, 600));
      response = await intentarProxy(true);
    }

    if (!response || (response.status !== 200 && response.status !== 206)) {
      return res.status(response ? response.status : 502).json({
        error: `Servidor remoto devolvió HTTP ${response ? response.status : 'desconectado'}`
      });
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    // Si la URL resuelta es una playlist HLS M3U8 de SoundCloud, ensamblar sus segmentos fMP4/MP3 en memoria y entregar el archivo de audio continuo
    if (
      contentTypeRemoto.includes('mpegurl') ||
      audioUrl.includes('playback.media-streaming.soundcloud.cloud') ||
      audioUrl.includes('.m3u8')
    ) {
      try {
        console.log(`[/api/proxy-stream]: Ensamblando playlist HLS SoundCloud en archivo de audio continuo...`);
        const ensamblado = await ensamblarHlsSoundCloudABuffer(audioUrl);
        res.setHeader('Content-Type', ensamblado.mime);
        res.setHeader('Content-Length', ensamblado.buffer.length);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).send(ensamblado.buffer);
      } catch (errHls) {
        console.warn(`[/api/proxy-stream HLS Muxer Falló]:`, errHls.message);
        return res.status(502).json({ error: 'No se pudo ensamblar el stream HLS' });
      }
    }

    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('text/plain') ||
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

    if (response.headers['content-range']) {
      res.setHeader('Content-Range', response.headers['content-range']);
      res.status(206);
    } else {
      res.status(200);
    }

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
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Titulo-Audio, X-Calidad-Audio');

  let respondido = false;
  let streamActivo = null;

  const timeoutGuard = setTimeout(() => {
    if (!respondido && !res.headersSent) {
      respondido = true;
      if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
      return res.status(504).json({
        error: true,
        mensaje: 'Audio no disponible temporalmente (Tiempo de espera agotado >60s)'
      });
    }
  }, 65000);

  const responderError = (status, mensaje) => {
    clearTimeout(timeoutGuard);
    if (!respondido && !res.headersSent) {
      respondido = true;
      if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
      return res.status(status).json({ error: true, mensaje });
    }
  };

  res.on('close', () => {
    clearTimeout(timeoutGuard);
    if (streamActivo && typeof streamActivo.destroy === 'function') {
      streamActivo.destroy();
    }
  });

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();
  const formatoDeseado = (req.query.formato || req.query.calidad || req.query.format || 'mp3').toLowerCase().trim();

  if (!busqueda && !videoId) {
    return responderError(400, 'Debes enviar ?q= o ?videoId=');
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/descargar-cancion (${formatoDeseado}): "${busqueda}" (videoId: ${videoId || 'auto'})`);

  try {
    let video = null;

    if (videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido }
      };
    } else {
      video = await buscarVideoEnYouTube(busqueda, artistaSugerido, duracionSugerida);
      if (video) {
        video.duracionRef = duracionSugerida || video.seconds || 0;
        video.tituloOriginal = busqueda;
        video.artistaOriginal = artistaSugerido;
      }
    }

    if (!video) {
      return responderError(404, 'Audio oficial no disponible');
    }

    const trackTitle = video.title || busqueda;

    // 1. Resolver enlace mediante la cascada oficial de estudio (Prohibido covers de relleno)
    let resultadoAudio = await resolverAudioConCascada(video, busqueda, formatoDeseado);

    if (!resultadoAudio || !resultadoAudio.url) {
      return responderError(404, 'Audio oficial no disponible');
    }

    let downloadUrl = resultadoAudio.url.replace(/^http:\/\//i, 'https://');
    console.log(`[Descarga Directa (${resultadoAudio.calidad} / ${resultadoAudio.proveedor})]: Conectando stream...`);

    // Si es un stream HLS de SoundCloud, ensamblar los segmentos directamente en un archivo completo y enviarlo
    if (
      resultadoAudio.esHlsSoundCloud ||
      downloadUrl.includes('playback.media-streaming.soundcloud.cloud') ||
      downloadUrl.includes('.m3u8')
    ) {
      try {
        const ensamblado = await ensamblarHlsSoundCloudABuffer(downloadUrl);
        clearTimeout(timeoutGuard);
        respondido = true;
        const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
        res.setHeader('Content-Type', ensamblado.mime);
        res.setHeader('Content-Length', ensamblado.buffer.length);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
        res.setHeader('X-Calidad-Audio', resultadoAudio.calidad);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);
        return res.status(200).send(ensamblado.buffer);
      } catch (errHlsDesc) {
        console.warn(`[/api/descargar-cancion HLS Muxer Falló]:`, errHlsDesc.message);
      }
    }

    // 2. Conectar y transmitir el stream con timeout de 60 segundos
    async function intentarConectarStream(urlRemota) {
      return await axios({
        method: 'get',
        url: urlRemota,
        responseType: 'stream',
        signal: AbortSignal.timeout(60000),
        timeout: 60000,
        headers: {
          'Referer': 'https://loader.to/',
          'User-Agent': UA,
          'Accept': '*/*'
        },
        maxRedirects: 5,
        validateStatus: () => true
      });
    }

    let response = null;
    try {
      response = await intentarConectarStream(downloadUrl);
    } catch (errAxios) {
      console.warn(`[Stream Error Axios (${resultadoAudio.proveedor})]:`, errAxios.message);
    }

    // Comprobar si el stream de alta calidad falló o saturó
    const esValido = response && response.status === 200 && (() => {
      const ct = (response.headers['content-type'] || '').toLowerCase();
      return !ct.includes('text/html') && !ct.includes('application/json') && !ct.includes('mpegurl');
    })();

    // DEGRADACIÓN ELEGANTE (Downgrade Transparente): Si 320k falló o saturó, conmutar a flujo estándar
    if (!esValido) {
      console.warn(`[Downgrade Transparente]: Proveedor inicial (${resultadoAudio.proveedor}) saturado o fallido. Conmutando a flujo estándar (160k/128k)...`);
      try {
        const fallbackAudio = await resolverAudioConCascada(video, busqueda, 'mp3');
        if (fallbackAudio && fallbackAudio.url && fallbackAudio.url !== downloadUrl) {
          resultadoAudio = fallbackAudio;
          downloadUrl = fallbackAudio.url.replace(/^http:\/\//i, 'https://');
          response = await intentarConectarStream(downloadUrl);
        }
      } catch (errFallback) {
        console.warn(`[Aviso Downgrade]:`, errFallback.message);
      }
    }

    if (!response || response.status !== 200) {
      return responderError(response ? response.status : 502, 'Audio no disponible temporalmente');
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('application/json') ||
      contentTypeRemoto.includes('application/vnd.apple.mpegurl') ||
      contentTypeRemoto.includes('application/x-mpegurl')
    ) {
      return responderError(500, 'Audio no disponible temporalmente');
    }

    clearTimeout(timeoutGuard);
    respondido = true;

    const esVideo = formatoDeseado.includes('360') || formatoDeseado.includes('720') || formatoDeseado.includes('1080') || formatoDeseado.includes('144') || formatoDeseado.includes('240');
    const esM4a = formatoDeseado === 'm4a';

    let mime = 'audio/mpeg';
    let ext = 'mp3';
    if (esVideo) {
      mime = 'video/mp4';
      ext = 'mp4';
    } else if (esM4a) {
      mime = 'audio/mp4';
      ext = 'm4a';
    } else if (response.headers['content-type'] && response.headers['content-type'].startsWith('audio/')) {
      mime = response.headers['content-type'];
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
    res.setHeader('X-Calidad-Audio', resultadoAudio.calidad);

    const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.${ext}"`);

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    let axiosStream = response.data;
    streamActivo = axiosStream;

    axiosStream.on('error', (err) => {
      console.error('[/api/descargar-cancion Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: true, mensaje: 'Audio no disponible temporalmente' });
      } else {
        res.destroy();
      }
    });

    axiosStream.pipe(res);

  } catch (error) {
    console.error(`[Error /api/descargar-cancion]:`, error.message || error);
    return responderError(500, 'Audio no disponible temporalmente');
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

// Rutas de compatibilidad y streaming directo (/api/stream y /stream)
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id || req.query.videoId || '';
  const titulo = req.query.titulo || req.query.q || '';
  const artist = req.query.artist || '';
  const seconds = req.query.seconds || 0;
  const qFinal = `${titulo} ${artist}`.trim();
  return res.redirect(
    307,
    `/api/proxy-stream?videoId=${encodeURIComponent(videoId)}&q=${encodeURIComponent(qFinal)}&seconds=${encodeURIComponent(seconds)}&tipo=preview`
  );
});
app.get('/buscar', (req, res) => res.redirect(307, `/api/obtener-enlace?q=${encodeURIComponent(req.query.q || '')}`));
app.get('/stream', (req, res) => res.redirect(307, `/descargar?q=${encodeURIComponent(req.query.q || '')}`));

// Middleware anti-caché estricto para archivos de control PWA (sw.js, index.html, manifest)
// Esto asegura que los teléfonos y navegadores SIEMPRE reciban la versión más reciente al instante.
app.use((req, res, next) => {
  const ruta = (req.path || '').toLowerCase();
  if (
    ruta === '/sw.js' ||
    ruta === '/index.html' ||
    ruta === '/' ||
    ruta.endsWith('.webmanifest') ||
    ruta.endsWith('manifest.json')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Servir estáticos de la PWA compilada
app.use(express.static(RUTA_ESTATICOS, {
  setHeaders: (res, pathRes) => {
    const nombre = path.basename(pathRes).toLowerCase();
    const rutaNormalizada = pathRes.replace(/\\/g, '/').toLowerCase();
    if (nombre === 'sw.js' || nombre === 'index.html' || nombre.endsWith('.webmanifest') || nombre.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (rutaNormalizada.includes('/assets/') || nombre.endsWith('.js') || nombre.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Fallback SPA/PWA
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }

  // Prevenir que rutas de API desconocidas sirvan index.html
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: true, mensaje: 'Endpoint de API no encontrado' });
  }

  const archivoIndex = path.join(RUTA_ESTATICOS, 'index.html');
  if (fs.existsSync(archivoIndex)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(archivoIndex);
  }

  res.status(200).json({
    status: 'online',
    servicio: 'Servidor de Música Backend (API)',
    health: '/health',
    puerto: PUERTO,
    endpoints: [
      '/api/buscar-canciones?q=...',
      '/api/descargar-cancion?q=...&videoId=...',
      '/api/obtener-enlace?q=...',
      '/api/proxy-stream?url=...'
    ]
  });
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