const axios = require('axios');
const yts = require('yt-search');
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
// FILTRO ESTRICTO ANTI-COVERS Y PRIORIDAD DE VOZ ORIGINAL DEL ARTISTA
// ---------------------------------------------------------------------------
const REGEX_PERMITIDOS_EN_ORIGINAL = /\b(cover|karaoke|instrumental|remix|version|tributo|en\s*vivo|live|acustico|acústico)\b/i;
const REGEX_LISTA_NEGRA_COVERS = /\b(cover|karaoke|instrumental|tribute|tributo|8d|slowed|sped\s*up|nightcore|parodia|acustico|acústico|tutorial|type\s*beat|reverb|bass\s*boosted|chipmunk|ai\s*cover|imitacion|imitación)\b/i;

function normalizarTextoSimple(txt = '') {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Limpia paréntesis, corchetes y featuring secundarios de un título para consulta de rescate
 * Ej: "Canción (feat. Otro) [Remastered]" -> "Canción"
 */
function limpiarTituloParaRescate(titulo = '') {
  return String(titulo || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring|con|with)\s+[^-–—|]+$/i, ' ')
    .replace(/\s*[-–—|]\s*(remastered|version|edit|mix|mono|stereo|deluxe|bonus).*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Construye la consulta principal exacta estilo Spotify: "${artista} - ${titulo} Official Audio"
 * y la consulta alternativa de rescate: "${artista} ${tituloLimpio} audio"
 */
function construirConsultasOriginalYRescate(tituloRaw = '', artistaRaw = '') {
  let titulo = String(tituloRaw || '').trim();
  let artista = String(artistaRaw || '').trim();

  // Si el título ya venía como "Artista - Canción" o "Canción - Artista" y no había artista explícito
  if (!artista && titulo.includes(' - ')) {
    const partes = titulo.split(' - ').map((p) => p.trim()).filter(Boolean);
    if (partes.length >= 2) {
      artista = partes[0];
      titulo = partes.slice(1).join(' ');
    }
  } else if (artista && titulo.toLowerCase().endsWith(` - ${artista.toLowerCase()}`)) {
    titulo = titulo.slice(0, titulo.length - (` - ${artista}`).length).trim();
  } else if (artista && titulo.toLowerCase().startsWith(`${artista.toLowerCase()} - `)) {
    titulo = titulo.slice((`${artista} - `).length).trim();
  }

  const tituloLimpio = limpiarTituloParaRescate(titulo) || titulo;
  const artistaPrincipal = artista.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0].trim() || artista;

  const consultaOriginal = artista
    ? `${artista} - ${titulo} Official Audio`
    : `${titulo} Official Audio`;

  const consultaRescate = artistaPrincipal
    ? `${artistaPrincipal} ${tituloLimpio} audio`
    : `${tituloLimpio} audio`;

  return {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultaOriginal,
    consultaRescate
  };
}

/**
 * Evalúa si un candidato (de YouTube o SoundCloud) viola la lista negra anti-covers
 * cuando el título original de Spotify NO pide un cover/karaoke/remix/en vivo.
 */
function esResultadoEnListaNegra(tituloCandidato = '', autorCandidato = '', tituloOriginalSpotify = '') {
  const originalPideEspecial = REGEX_PERMITIDOS_EN_ORIGINAL.test(tituloOriginalSpotify || '');
  if (originalPideEspecial) return false;

  const textoEvaluar = `${tituloCandidato || ''} ${autorCandidato || ''}`;
  const textoNorm = normalizarTextoSimple(textoEvaluar);
  if (REGEX_LISTA_NEGRA_COVERS.test(textoEvaluar) || REGEX_LISTA_NEGRA_COVERS.test(textoNorm)) {
    return true;
  }
  // Si el original no pide remix ni live, penalizar remixes/live no solicitados
  if (!/\b(remix|mix)\b/i.test(tituloOriginalSpotify) && /\b(remix|bootleg|mashup|dj\s*mix)\b/i.test(textoEvaluar)) {
    return true;
  }
  return false;
}

/**
 * Calcula un puntaje de prioridad para elegir SIEMPRE la voz original del artista:
 * - Menor puntaje = Mejor coincidencia.
 * - Verifica coincidencia del artista en título o canal/autor.
 * - Descarta/penaliza lista negra anti-covers.
 * - Verifica tolerancia estricta de ±18 segundos respecto a duracionSegundos de Spotify.
 */
function evaluarCandidatoOriginal({
  tituloCandidato = '',
  autorCandidato = '',
  duracionSegsCandidato = 0,
  tituloOriginal = '',
  artistaOriginal = '',
  duracionRefSegs = 0,
  toleranciaMaxSegs = 18
}) {
  const enListaNegra = esResultadoEnListaNegra(tituloCandidato, autorCandidato, tituloOriginal);
  const diffSegs =
    duracionRefSegs > 30 && duracionSegsCandidato > 0
      ? Math.abs(duracionSegsCandidato - duracionRefSegs)
      : 0;
  const dentroToleranciaDuracion =
    !(duracionRefSegs > 30 && duracionSegsCandidato > 0) || diffSegs <= toleranciaMaxSegs;

  const normTituloCand = normalizarTextoSimple(tituloCandidato);
  const normAutorCand = normalizarTextoSimple(autorCandidato);
  const normArtistaOrig = normalizarTextoSimple(
    (artistaOriginal || '').split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0]
  );
  const normTituloOrig = normalizarTextoSimple(limpiarTituloParaRescate(tituloOriginal) || tituloOriginal);

  const coincideArtista =
    !normArtistaOrig ||
    normTituloCand.includes(normArtistaOrig) ||
    normAutorCand.includes(normArtistaOrig);

  const coincideTitulo =
    !normTituloOrig ||
    normTituloCand.includes(normTituloOrig) ||
    normTituloOrig.split(' ').filter((w) => w.length > 2).every((w) => normTituloCand.includes(w));

  const esCanalOficial =
    /\b(topic|official|oficial|vevo)\b/i.test(autorCandidato || '') ||
    /\b(official\s*audio|audio\s*oficial|provided\s*to\s*youtube)\b/i.test(tituloCandidato || '');

  let penalizacion = diffSegs * 1000;
  if (enListaNegra) penalizacion += 500000;
  if (!dentroToleranciaDuracion) penalizacion += 150000 + diffSegs * 2000;
  if (!coincideArtista) penalizacion += 60000;
  if (!coincideTitulo) penalizacion += 45000;
  if (esCanalOficial) penalizacion -= 12000;

  return {
    enListaNegra,
    dentroToleranciaDuracion,
    coincideArtista,
    coincideTitulo,
    diffSegs,
    penalizacion
  };
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

async function probarSoundCloud(busqueda, duracionRef, metaOriginal = {}) {
  try {
    let clientId = await obtenerClientIdSoundCloud();
    if (!clientId) clientId = await obtenerClientIdSoundCloud(true);
    if (!clientId) return null;

    const tituloOrig = metaOriginal.titulo || busqueda;
    const artistaOrig = metaOriginal.artista || '';
    const toleranciaSegs = metaOriginal.toleranciaSegs || 18;

    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 20 },
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

    // Evaluar cada pista con el filtro estricto anti-covers y duración ±18s
    const evaluadas = pistasReproducibles.map((p) => {
      const durSegs = Math.round((p.full_duration || 0) / 1000);
      const autorSc = p.user?.username || p.publisher_metadata?.artist || '';
      const ev = evaluarCandidatoOriginal({
        tituloCandidato: p.title || '',
        autorCandidato: autorSc,
        duracionSegsCandidato: durSegs,
        tituloOriginal: tituloOrig,
        artistaOriginal: artistaOrig,
        duracionRefSegs: duracionRef,
        toleranciaMaxSegs: toleranciaSegs
      });
      return { pista: p, ev };
    });

    // Descartar automáticamente resultados en lista negra (covers, karaoke, 8d, slowed, etc.)
    // y si Spotify envió duracionRef (>30s), exigir que la duración no difiera en más de ±toleranciaSegs (±18s)
    const candidatasValidas = evaluadas.filter((item) => {
      if (item.ev.enListaNegra) return false;
      if (duracionRef && duracionRef > 30 && !item.ev.dentroToleranciaDuracion) return false;
      return true;
    });

    if (!candidatasValidas.length) {
      console.log(`[Filtro Anti-Covers SoundCloud]: Se descartaron ${evaluadas.length} resultados por ser covers o diferir >±${toleranciaSegs}s de la duración original (${duracionRef}s)`);
      return null;
    }

    candidatasValidas.sort((a, b) => a.ev.penalizacion - b.ev.penalizacion);

    // Recorrer pistas en orden de fidelidad (la canción original exacta del artista primero)
    for (const { pista, ev } of candidatasValidas) {
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
            console.log(`[SoundCloud Progressive Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s, diff: ${ev.diffSegs}s)`);
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
            console.log(`[SoundCloud HLS Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s, diff: ${ev.diffSegs}s, ${elegido.format?.mime_type})`);
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
// BUSCADOR DE VIDEO EN YOUTUBE CON FILTRO ESTRICTO ANTI-COVERS Y RESCATE
// ---------------------------------------------------------------------------
async function buscarVideoOriginalEnYouTube(tituloRaw = '', artistaRaw = '', duracionRefSegs = 0) {
  const {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultaOriginal,
    consultaRescate
  } = construirConsultasOriginalYRescate(tituloRaw, artistaRaw);

  const filtrarYOrdenarCandidatos = (videos = [], toleranciaSegs = 18) => {
    const prefiltrados = (videos || []).filter(
      (item) => (item.seconds >= 45 && item.seconds <= 720) || !item.seconds
    );
    if (!prefiltrados.length) return [];

    const evaluados = prefiltrados.map((v) => {
      const autorNombre = v.author ? (v.author.name || v.author) : '';
      const ev = evaluarCandidatoOriginal({
        tituloCandidato: v.title || '',
        autorCandidato: autorNombre,
        duracionSegsCandidato: v.seconds || 0,
        tituloOriginal: titulo,
        artistaOriginal: artista,
        duracionRefSegs,
        toleranciaMaxSegs: toleranciaSegs
      });
      return { video: v, ev };
    });

    // 1. Intento estricto: sin lista negra y dentro de ±18 segundos (cuando duracionRefSegs > 30)
    const estrictos = evaluados.filter((item) => {
      if (item.ev.enListaNegra) return false;
      if (duracionRefSegs > 30 && item.video.seconds > 0 && !item.ev.dentroToleranciaDuracion) return false;
      return true;
    });

    if (estrictos.length > 0) {
      estrictos.sort((a, b) => a.ev.penalizacion - b.ev.penalizacion);
      return estrictos.map((x) => x.video);
    }

    // 2. Fallback sin covers pero tolerancia ligeramente mayor si el video oficial tiene outro
    const sinCovers = evaluados.filter((item) => !item.ev.enListaNegra);
    if (sinCovers.length > 0) {
      sinCovers.sort((a, b) => a.ev.penalizacion - b.ev.penalizacion);
      return sinCovers.map((x) => x.video);
    }

    return [];
  };

  // Intento 1: Consulta principal con formato exacto "${artista} - ${titulo} Official Audio"
  const consultasIntento = [consultaOriginal];
  if (consultaRescate && consultaRescate.toLowerCase() !== consultaOriginal.toLowerCase()) {
    consultasIntento.push(consultaRescate);
  }

  for (let idx = 0; idx < consultasIntento.length; idx++) {
    const q = consultasIntento[idx];
    try {
      const searchResult = await yts(q);
      const videos = searchResult && searchResult.videos ? searchResult.videos : [];
      const mejores = filtrarYOrdenarCandidatos(videos, 18);
      if (mejores.length > 0) {
        if (idx > 0) {
          console.log(`[Rescate YouTube Éxito]: Encontrado con consulta limpia "${q}" -> "${mejores[0].title}"`);
        }
        return mejores[0];
      }
    } catch (_) {}
  }

  // Fallback Invidious con filtro anti-covers
  const invidiousHosts = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.jing.rocks'
  ];
  for (const host of invidiousHosts) {
    try {
      const resp = await axios.get(`${host}/api/v1/search`, {
        params: { q: consultaOriginal, type: 'video' },
        timeout: 4500,
        headers: { 'User-Agent': UA }
      });
      if (Array.isArray(resp.data) && resp.data.length > 0) {
        const mapeados = resp.data.map((item) => ({
          videoId: item.videoId,
          title: item.title,
          seconds: item.lengthSeconds || 0,
          author: { name: item.author || artista }
        }));
        const mejores = filtrarYOrdenarCandidatos(mapeados, 18);
        if (mejores.length > 0) return mejores[0];
      }
    } catch (_) {}
  }

  // Si todo lo anterior falló, devolver el primer resultado limpio de la consulta de rescate
  try {
    const resRescate = await yts(`${artistaPrincipal} ${tituloLimpio}`.trim());
    const vids = resRescate && resRescate.videos ? resRescate.videos : [];
    const limpios = filtrarYOrdenarCandidatos(vids, 35);
    if (limpios.length > 0) return limpios[0];
    if (vids.length > 0) return vids[0];
  } catch (_) {}

  return null;
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA CON FILTRO ANTI-COVERS Y RESCATE AUTOMÁTICO
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const esYouTubeValido = video && video.videoId && video.videoId.length === 11 && !video.videoId.startsWith('itunes_');
  let videoUrl = esYouTubeValido ? `https://www.youtube.com/watch?v=${video.videoId}` : null;
  const duracionRef = video?.duracionRef || video?.seconds || 0;
  const artistaOriginal = video?.artistaOriginal || (video?.author && video.author.name) || '';
  const tituloOriginal = video?.tituloOriginal || busqueda || video?.title || '';

  const {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultaOriginal,
    consultaRescate
  } = construirConsultasOriginalYRescate(tituloOriginal, artistaOriginal);

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Resiliente Anti-Covers]: Resolviendo "${consultaOriginal}" (ID: ${video?.videoId || 'auto'}, DurRef: ${duracionRef}s, Formato: ${formato})`);

  const metaOriginal = {
    titulo,
    artista,
    toleranciaSegs: 18
  };

  // 1. NIVEL 1: SoundCloud Progressive + HLS Muxer con formato exacto "${artista} - ${titulo} Official Audio" y filtro ±18s
  const consultaScPrimaria = artista ? `${artista} - ${titulo}` : consultaOriginal;
  try {
    const resSc = await Promise.race([
      probarSoundCloud(consultaScPrimaria, duracionRef, metaOriginal),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SoundCloud Timeout 10s')), 10000))
    ]);
    if (resSc && resSc.url) {
      return resSc;
    }
  } catch (eSc) {
    console.warn(`[Nivel 1 SoundCloud]: Pasando a Nivel 2 (${eSc.message})`);
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

  // -------------------------------------------------------------------------
  // 4. SEGUNDO INTENTO DE RESCATE AUTOMÁTICO (Limpia paréntesis/featuring y prueba proveedores alternativos)
  // -------------------------------------------------------------------------
  console.log(`[Rescate Automático]: Ejecutando segundo intento de rescate con consulta limpia: "${consultaRescate}"`);

  // 4.A. Rescate en SoundCloud con consulta limpia "${artistaPrincipal} ${tituloLimpio}"
  const consultaScRescate = `${artistaPrincipal} ${tituloLimpio}`.trim();
  if (consultaScRescate) {
    try {
      const resScRescate = await Promise.race([
        probarSoundCloud(consultaScRescate, duracionRef, {
          titulo: tituloLimpio,
          artista: artistaPrincipal,
          toleranciaSegs: 25
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SoundCloud Rescate Timeout 9s')), 9000))
      ]);
      if (resScRescate && resScRescate.url) {
        console.log(`[Rescate Automático Éxito]: Recuperada vía SoundCloud con consulta limpia "${consultaScRescate}"`);
        return resScRescate;
      }
    } catch (_) {}
  }

  // 4.B. Rescate buscando un video alternativo en YouTube con la consulta limpia "${artistaPrincipal} ${tituloLimpio} audio"
  try {
    const videoRescate = await buscarVideoOriginalEnYouTube(tituloLimpio, artistaPrincipal, duracionRef);
    if (videoRescate && videoRescate.videoId) {
      const urlVideoRescate = `https://www.youtube.com/watch?v=${videoRescate.videoId}`;
      if (urlVideoRescate !== videoUrl) {
        const resYtdlRescate = await Promise.race([
          resolverNativoYtdl(urlVideoRescate),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Rescate YTDL Timeout 8s')), 8000))
        ]).catch(() => null);
        if (resYtdlRescate && resYtdlRescate.url) {
          console.log(`[Rescate Automático Éxito]: Recuperada vía YTDL con video alternativo (${videoRescate.videoId})`);
          return resYtdlRescate;
        }
      }
      const resLoaderRescate = await Promise.race([
        probarLoaderSavenow(urlVideoRescate, formato),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Rescate Loader Timeout 8s')), 8000))
      ]).catch(() => null);
      if (resLoaderRescate && resLoaderRescate.url) {
        console.log(`[Rescate Automático Éxito]: Recuperada vía Loader con video alternativo (${videoRescate.videoId})`);
        return resLoaderRescate;
      }
    }
  } catch (_) {}

  console.error(`[Cascada Agotada]: Todos los extractores e intentos de rescate fallaron para "${consultaOriginal}".`);
  return null;
}

module.exports = {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato,
  getTimeoutSignal,
  buscarVideoOriginalEnYouTube,
  construirConsultasOriginalYRescate,
  limpiarTituloParaRescate,
  evaluarCandidatoOriginal,
  esResultadoEnListaNegra
};
