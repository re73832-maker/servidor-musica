const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TAMANO_MINIMO = 1048576; // 1 MB (1048576 bytes): mínimo absoluto para audio completo

// Middleware y CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Titulo-Audio']
}));

app.use(express.json());

// Endpoint de chequeo de salud / actividad para Render
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    port: PUERTO,
    engine: 'YouTube Official + Cobalt + Invidious/Piped + Direct MP3 + Guaranteed Fallback'
  });
});

/**
 * Descarga y valida un stream de audio remoto en memoria:
 * 1. Verifica HTTP status 200.
 * 2. Si content-type es text/html o application/json, lo DESCARTA.
 * 3. Si content-length existe y es menor a 1 MB, lo DESCARTA.
 * 4. Acumula chunks contando bytes. Si el stream se corta antes de 1 MB, lo DESCARTA.
 */
async function descargarYValidarAudio(streamUrl, headersExtra = {}, etiqueta = 'Stream') {
  console.log(`[Validando ${etiqueta}]: Solicitando stream desde ${streamUrl.substring(0, 80)}...`);

  const resp = await axios.get(streamUrl, {
    responseType: 'stream',
    timeout: 35000,
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      ...headersExtra
    },
    validateStatus: () => true
  });

  if (resp.status !== 200) {
    throw new Error(`${etiqueta}: HTTP status ${resp.status}`);
  }

  const cType = String(resp.headers['content-type'] || '').toLowerCase();
  const cLen = parseInt(resp.headers['content-length'] || '0', 10);

  // Validación de Content-Type
  if (cType.includes('text/html') || cType.includes('application/json')) {
    throw new Error(`${etiqueta}: content-type inválido (${cType}) - posible página de error o captcha`);
  }

  // Validación de Content-Length previo
  if (cLen > 0 && cLen < TAMANO_MINIMO) {
    throw new Error(`${etiqueta}: content-length menor a 1 MB (${cLen} bytes)`);
  }

  // Descarga controlada de chunks verificando tamaño real recibido
  const chunks = [];
  let totalBytes = 0;

  await new Promise((resolve, reject) => {
    resp.data.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });

    resp.data.on('end', () => {
      resolve();
    });

    resp.data.on('error', (err) => {
      reject(new Error(`${etiqueta}: error en transmisión de datos - ${err.message}`));
    });
  });

  // Validación final de bytes recibidos
  if (totalBytes < TAMANO_MINIMO) {
    throw new Error(`${etiqueta}: stream cortado prematuramente (recibidos ${totalBytes} bytes < 1 MB)`);
  }

  const buffer = Buffer.concat(chunks);
  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
  console.log(`[Validación Exitosa ${etiqueta}]: Descargados ${sizeMB} MB válidos.`);
  return { buffer, contentType: cType.includes('audio') ? cType : 'audio/mpeg' };
}

// ---------------------------------------------------------------------------
// Proveedor 1: Cobalt Instances (sin JWT)
// ---------------------------------------------------------------------------
async function proveedorCobalt(videoUrl) {
  const cobaltInstances = [
    'https://cobalt-api.kwiatekm.tokyo/',
    'https://api.cobalt.0011001100.xyz/',
    'https://cobalt.tools.api.alextesting.ninja/',
    'https://api.savefrom.net/'
  ];

  for (const cobaltUrl of cobaltInstances) {
    try {
      console.log(`[Cobalt]: Probando instancia ${cobaltUrl}...`);
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
        timeout: 5000,
        validateStatus: () => true
      });

      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        console.log(`[Cobalt]: Stream URL obtenida de ${cobaltUrl}, validando descarga...`);
        const resultado = await descargarYValidarAudio(cRes.data.url, {}, `Cobalt (${cobaltUrl})`);
        return resultado;
      }
    } catch (e) {
      console.warn(`[Cobalt]: Falló ${cobaltUrl} - ${e.message}`);
    }
  }

  throw new Error('Cobalt: ninguna instancia entregó audio válido');
}

// ---------------------------------------------------------------------------
// Proveedor 2: Extractor Directo MP3 (Savenow / LBServer con cabeceras completas)
// ---------------------------------------------------------------------------
async function proveedorExtractorDirecto(videoUrl) {
  const dominiosExtractor = [
    'https://p.savenow.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominiosExtractor) {
    try {
      console.log(`[Extractor Directo]: Solicitando a ${dominio}...`);
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: 'mp3', url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
        timeout: 8000
      });

      if (!startRes.data || !startRes.data.id) {
        continue;
      }

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;
      let streamUrl = null;

      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const pRes = await axios.get(progressUrl, {
          headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
          timeout: 8000
        });

        if (pRes.data && pRes.data.success === 1 && pRes.data.download_url) {
          streamUrl = pRes.data.download_url;
          console.log(`[Extractor Directo]: Audio preparado en ${dominio}`);
          break;
        }

        if (pRes.data && pRes.data.text && pRes.data.text.toLowerCase().includes('error')) {
          break;
        }
      }

      if (streamUrl) {
        // Importante: Enviar Referer: https://loader.to/ para evitar bloqueo de Cloudflare en Render
        const resultado = await descargarYValidarAudio(
          streamUrl,
          { 'Referer': 'https://loader.to/' },
          `Extractor Directo (${dominio})`
        );
        return resultado;
      }
    } catch (err) {
      console.warn(`[Extractor Directo]: Falló ${dominio} - ${err.message}`);
    }
  }

  throw new Error('Extractor Directo: ninguno entregó audio válido');
}

// ---------------------------------------------------------------------------
// Proveedor 3: Invidious / Piped Mirrors Públicos
// ---------------------------------------------------------------------------
async function proveedorInvidiousPiped(videoId) {
  const invidiousHosts = [
    'https://invidious.f5.si',
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de'
  ];

  for (const host of invidiousHosts) {
    try {
      console.log(`[Invidious]: Probando ${host}...`);
      // 1. Probar endpoint directo /latest_version
      const directUrl = `${host}/latest_version?id=${videoId}&itag=140`;
      try {
        const res = await descargarYValidarAudio(directUrl, {}, `Invidious Direct (${host})`);
        return res;
      } catch (_) {}

      // 2. Probar API de video para formatos adaptativos
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, { timeout: 6000, headers: { 'User-Agent': UA } });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos[0];

      if (mejor && mejor.url) {
        const res = await descargarYValidarAudio(mejor.url, {}, `Invidious Audio (${host})`);
        return res;
      }
    } catch (e) {
      console.warn(`[Invidious]: ${host} falló - ${e.message}`);
    }
  }

  const pipedHosts = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.adminforge.de',
    'https://api.piped.private.coffee'
  ];

  for (const host of pipedHosts) {
    try {
      console.log(`[Piped]: Probando ${host}...`);
      const r = await axios.get(`${host}/streams/${videoId}`, { timeout: 6000, headers: { 'User-Agent': UA } });
      const mejor = (r.data?.audioStreams || []).filter((a) => a.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      if (mejor && mejor.url) {
        const res = await descargarYValidarAudio(mejor.url, {}, `Piped (${host})`);
        return res;
      }
    } catch (e) {
      console.warn(`[Piped]: ${host} falló - ${e.message}`);
    }
  }

  throw new Error('Invidious/Piped: sin stream válido');
}

// ---------------------------------------------------------------------------
// Proveedor 4: Fallback Garantizado para Datacenters (SoundCloud API v2 oficial)
// ---------------------------------------------------------------------------
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  const html = (await axios.get('https://soundcloud.com/', { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .reverse();

  for (const src of scripts) {
    try {
      const js = (await axios.get(src, { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
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

async function proveedorSoundCloudGarantizado(busqueda, duracionRef) {
  let clientId = await obtenerClientIdSoundCloud();
  console.log(`[Fallback SoundCloud]: Buscando pista completa para "${busqueda}"...`);

  let r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
    params: { q: busqueda, client_id: clientId, limit: 15 },
    headers: { 'User-Agent': UA },
    timeout: 10000
  });

  const pistas = (r.data?.collection || [])
    .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
    .filter((p) => p.full_duration > 60000)
    .filter((p) => Math.abs(p.duration - p.full_duration) < 5000);

  if (!pistas.length) {
    throw new Error('SoundCloud: no se encontraron pistas completas');
  }

  // Elegir pista más similar en duración si tenemos duracionRef
  let seleccionada = pistas[0];
  if (duracionRef) {
    const refMs = duracionRef * 1000;
    pistas.sort((a, b) => Math.abs(a.full_duration - refMs) - Math.abs(b.full_duration - refMs));
    seleccionada = pistas[0];
  }

  console.log(`[SoundCloud]: Seleccionada "${seleccionada.title}" (${(seleccionada.full_duration / 1000).toFixed(0)}s)`);

  const trans = seleccionada.media?.transcodings || [];
  const progresivo = trans.find((t) => t.format?.protocol === 'progressive')
    || trans.find((t) => t.format?.mime_type === 'audio/mpeg')
    || trans[0];

  if (!progresivo) throw new Error('SoundCloud: sin transcodificación disponible');

  const streamInfo = await axios.get(progresivo.url, {
    params: { client_id: clientId },
    headers: { 'User-Agent': UA },
    timeout: 10000
  });

  if (!streamInfo.data?.url) throw new Error('SoundCloud: sin url directa');

  const res = await descargarYValidarAudio(streamInfo.data.url, {}, 'SoundCloud Fallback');
  return res;
}

// ---------------------------------------------------------------------------
// Endpoint Principal de Descarga / Stream
// ---------------------------------------------------------------------------
async function manejarDescargaAudio(req, res) {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud de descarga oficial: "${busqueda}"`);

  try {
    // 1. Búsqueda oficial en YouTube con yt-search
    console.log(`[Paso 1]: Buscando versión oficial en YouTube...`);
    const consultaBusqueda = `${busqueda} audio oficial`;
    const searchResult = await yts(consultaBusqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];

    const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
      || videos.find((v) => v.seconds > 60)
      || videos[0];

    if (!video) {
      console.warn(`[Aviso]: No se encontraron videos para "${busqueda}".`);
      return res.status(404).json({ error: 'No se encontró el video oficial en YouTube.' });
    }

    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    const trackTitle = video.title || busqueda;
    console.log(`[Video Oficial]: "${trackTitle}" (${video.timestamp || video.seconds + 's'}) -> ${videoUrl}`);

    // 2. Cascada de Proveedores con Validación Real (> 1 MB, no HTML/JSON)
    const proveedores = [
      { nombre: 'Cobalt Instances', fn: () => proveedorCobalt(videoUrl) },
      { nombre: 'Extractor Directo MP3 (Savenow / LBServer)', fn: () => proveedorExtractorDirecto(videoUrl) },
      { nombre: 'Invidious / Piped API', fn: () => proveedorInvidiousPiped(video.videoId) },
      { nombre: 'SoundCloud Datacenter Fallback', fn: () => proveedorSoundCloudGarantizado(busqueda, video.seconds) }
    ];

    let audioResultado = null;

    for (const prov of proveedores) {
      if (res.writableEnded || req.socket.destroyed) {
        console.log(`[Aviso]: Cliente desconectado antes de completar la descarga.`);
        return;
      }

      try {
        console.log(`[Cascada]: Intentando proveedor: ${prov.nombre}...`);
        audioResultado = await prov.fn();
        if (audioResultado && audioResultado.buffer && audioResultado.buffer.length >= TAMANO_MINIMO) {
          console.log(`[Éxito Proveedor]: Proveedor ${prov.nombre} entregó audio válido verificado.`);
          break;
        }
      } catch (errProv) {
        console.warn(`[Proveedor Descartado]: ${prov.nombre} no entregó audio válido: ${errProv.message}`);
      }
    }

    // 3. Si se obtuvo audio validado, enviarlo limpiamente al cliente
    if (audioResultado && audioResultado.buffer) {
      if (res.writableEnded || req.socket.destroyed) return;

      const { buffer, contentType } = audioResultado;

      res.setHeader('Content-Type', contentType || 'audio/mpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(trackTitle)}.mp3"`);
      res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
      res.setHeader('Cache-Control', 'no-cache');

      console.log(`[ÉXITO]: Entregando ${(buffer.length / (1024 * 1024)).toFixed(2)} MB de audio oficial al cliente.`);
      return res.status(200).end(buffer);
    }

    // 4. Si el stream se cierra o falla antes de 1 MB en todos los proveedores, emitir error 502
    console.error(`[Fallo Definitivo]: La descarga fue interrumpida por el proveedor para "${busqueda}".`);
    if (!res.headersSent) {
      return res.status(502).json({ error: "La descarga fue interrumpida por el proveedor" });
    }

  } catch (errorGeneral) {
    console.error(`[Error no controlado]:`, errorGeneral.message || errorGeneral);
    if (!res.headersSent) {
      return res.status(502).json({ error: "La descarga fue interrumpida por el proveedor" });
    }
  }
}

// Rutas de API
app.get('/descargar', manejarDescargaAudio);
app.get('/buscar', manejarDescargaAudio);
app.get('/stream', manejarDescargaAudio);

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
    console.log(` Motor: YouTube Oficial + Cobalt + Direct MP3 + Fallback`);
    console.log(` Validación estricta: > 1 MB + No HTML/Captcha + Error 502`);
    console.log(` Aplicación web y API: http://localhost:${PUERTO}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;