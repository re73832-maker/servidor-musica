const axios = require('axios');
const yts = require('yt-search');
const YTMusicPkg = require('ytmusic-api');
const YTMusic = YTMusicPkg.default || YTMusicPkg;
const { Ytdl } = require('@distube/ytdl-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ytdlInstance = new Ytdl();

// Instancia cacheada en memoria del cliente oficial YouTube Music (categoría SONG DDEX)
let ytmusicInstancia = null;
let ytmusicInitPromise = null;

async function obtenerClienteYTMusic() {
  if (ytmusicInstancia) return ytmusicInstancia;
  if (!ytmusicInitPromise) {
    const cliente = new YTMusic();
    ytmusicInitPromise = cliente
      .initialize()
      .then(() => {
        ytmusicInstancia = cliente;
        return cliente;
      })
      .catch((err) => {
        ytmusicInitPromise = null;
        throw err;
      });
  }
  return ytmusicInitPromise;
}

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
// FILTRO DISCOGRÁFICO ESTRICTO ANTI-COVERS Y PRIORIDAD DE AUDIO ORIGINAL DE ESTUDIO
// ---------------------------------------------------------------------------
const PALABRAS_LISTA_NEGRA_ESTRICTA = [
  'cover',
  'karaoke',
  'instrumental',
  'tribute',
  'tributo',
  'nightcore',
  'sped up',
  'slowed',
  '8d',
  'parodia',
  'acústico',
  'acustico',
  'acoustic',
  'session',
  'live',
  'en vivo',
  'fan',
  'version',
  'versión',
  'letra',
  'lyrics',
  'remix',
  'bootleg',
  'mashup',
  'reverb',
  'tutorial',
  'ai cover',
  'imitacion',
  'imitación',
  'video oficial',
  'official video',
  'music video',
  'videoclip',
  'intro',
  'dj',
  'mix',
  'concierto',
  'beat',
  'skit',
  'video'
];

// Tolerancia máxima de duración frente al máster oficial de estudio (v4.6.0 Studio-Pure: ±2s)
const TOLERANCIA_DURACION_OFICIAL_SEGS = 2;

// ---------------------------------------------------------------------------
// PASO A — VERIFICACIÓN DE MÁSTER OFICIAL (Deezer API pública + respaldo iTunes)
// Obtiene la duración oficial de estudio y el nombre canónico del artista.
// ---------------------------------------------------------------------------
const cacheMasterOficial = new Map();

function normMaster(txt = '') {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function coincideMaster(tituloCand, artistaCand, tituloRef, artistaRef) {
  const tC = normMaster(tituloCand);
  const aC = normMaster(artistaCand);
  const tR = normMaster(tituloRef);
  const aR = normMaster(artistaRef);
  if (!tC || !tR) return false;
  const palabras = tR.split(' ').filter((w) => w.length >= 2);
  const coincTit =
    tC === tR || tC.includes(tR) || tR.includes(tC) ||
    (palabras.length > 0 && palabras.filter((w) => tC.includes(w)).length >= Math.ceil(palabras.length * 0.75));
  const coincArt = !aR || (aC && (aC.includes(aR) || aR.includes(aC)));
  return Boolean(coincTit && coincArt);
}

async function obtenerMasterOficial(titulo = '', artista = '', duracionSpotifySegs = 0, isrc = '') {
  const isrcLimpio = String(isrc || '').trim();
  if (!isrcLimpio && (!titulo || !artista)) return null;
  const clave = isrcLimpio ? `isrc:${isrcLimpio}` : `${normMaster(artista)}|${normMaster(titulo)}`;
  const cached = cacheMasterOficial.get(clave);
  if (cached && Date.now() - cached.t < 6 * 60 * 60 * 1000) return cached.data;

  const elegirMejor = (candidatos) => {
    const validos = candidatos.filter((c) => c.duracionOficialSeg >= 30 && coincideMaster(c.titulo, c.artista, titulo, artista));
    if (!validos.length) return null;
    if (duracionSpotifySegs > 0) {
      validos.sort((a, b) => Math.abs(a.duracionOficialSeg - duracionSpotifySegs) - Math.abs(b.duracionOficialSeg - duracionSpotifySegs));
    }
    return validos[0];
  };

  let resultado = null;

  // 0) Si hay ISRC, consultar directamente el máster oficial en Deezer
  if (isrcLimpio) {
    try {
      const rIsrc = await axios.get(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrcLimpio)}`, {
        timeout: 6000,
        headers: { 'User-Agent': UA }
      });
      if (rIsrc.data && !rIsrc.data.error && Number(rIsrc.data.duration) >= 30) {
        resultado = {
          titulo: rIsrc.data.title || rIsrc.data.title_short || titulo,
          artista: rIsrc.data.artist?.name || artista,
          duracionOficialSeg: Number(rIsrc.data.duration),
          fuente: 'Deezer-ISRC'
        };
      }
    } catch (eIsrc) {
      console.warn('[Máster Oficial Deezer ISRC]: aviso', eIsrc.message);
    }
  }

  // 1) Deezer API pública por artista + track (con respaldo de búsqueda abierta)
  if (!resultado && titulo && artista) {
    try {
      const q = `artist:"${artista}" track:"${titulo}"`;
      const r = await axios.get('https://api.deezer.com/search', {
        params: { q, limit: 5 },
        timeout: 5000,
        headers: { 'User-Agent': UA }
      });
      let lista = Array.isArray(r.data?.data) ? r.data.data : [];
      if (lista.length === 0) {
        const r2 = await axios.get('https://api.deezer.com/search', {
          params: { q: `${artista} ${titulo}`, limit: 8 },
          timeout: 5000,
          headers: { 'User-Agent': UA }
        });
        lista = Array.isArray(r2.data?.data) ? r2.data.data : [];
      }
      resultado = elegirMejor(
        lista.map((it) => ({
          titulo: it.title || it.title_short || '',
          artista: it.artist?.name || '',
          duracionOficialSeg: Number(it.duration) || 0,
          fuente: 'Deezer'
        }))
      );
    } catch (eDz) {
      console.warn('[Máster Oficial Deezer]: aviso', eDz.message);
    }
  }

  // 2) Respaldo: iTunes Search API
  if (!resultado) {
    try {
      const r = await axios.get(
        `https://itunes.apple.com/search?term=${encodeURIComponent(artista + ' ' + titulo)}&entity=song&limit=3`,
        { timeout: 6000, headers: { 'User-Agent': UA } }
      );
      const lista = Array.isArray(r.data?.results) ? r.data.results : [];
      resultado = elegirMejor(
        lista.map((it) => ({
          titulo: it.trackName || '',
          artista: it.artistName || '',
          duracionOficialSeg: Math.round((Number(it.trackTimeMillis) || 0) / 1000),
          fuente: 'iTunes'
        }))
      );
    } catch (eIt) {
      console.warn('[Máster Oficial iTunes]: aviso', eIt.message);
    }
  }

  const data = resultado
    ? {
        duracionOficialSeg: resultado.duracionOficialSeg,
        artistaCanonico: resultado.artista,
        tituloCanonico: resultado.titulo,
        fuente: resultado.fuente
      }
    : null;

  if (cacheMasterOficial.size > 500) cacheMasterOficial.delete(cacheMasterOficial.keys().next().value);
  cacheMasterOficial.set(clave, { t: Date.now(), data });
  if (data) {
    console.log(`[Máster Oficial ${data.fuente}]: "${data.artistaCanonico} - ${data.tituloCanonico}" = ${data.duracionOficialSeg}s`);
  }
  return data;
}

/**
 * Decide la duración de referencia estricta:
 * - Si hay máster oficial y Spotify, y difieren ≤ 6s, se usa el promedio.
 * - Si difieren más (otra edición/versión), se respeta la pista exacta de Spotify.
 * - Si solo hay uno, se usa ese.
 */
function resolverDuracionReferencia(duracionSpotifySegs = 0, master = null) {
  const sp = Number(duracionSpotifySegs) || 0;
  const of = master && master.duracionOficialSeg ? Number(master.duracionOficialSeg) : 0;
  if (sp > 0 && of > 0) {
    return Math.abs(sp - of) <= 6 ? Math.round((sp + of) / 2) : sp;
  }
  return of || sp || 0;
}

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
 * Limpia paréntesis, corchetes y featuring secundarios de un título
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
 * Separa título y artista limpios y construye las 3 consultas discográficas obligatorias en orden:
 * 1) "Provided to YouTube by" "${titulo}" "${artista}"
 * 2) "${titulo}" "${artista} - Topic"
 * 3) "${artista}" "${titulo}" "Official Audio"
 */
function construirConsultasOriginalYRescate(tituloRaw = '', artistaRaw = '') {
  let titulo = String(tituloRaw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let artista = String(artistaRaw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  const artistaPrincipal =
    artista
      .split(/,|;|\/|&|\bfeat\.?\b|\bft\.?\b|\bx\b/i)[0]
      .replace(/\u00a0/g, ' ')
      .trim() || artista;

  const consultasDiscograficas = artistaPrincipal
    ? [
        `"${artistaPrincipal}" "${tituloLimpio}" "Provided to YouTube"`,
        `"${tituloLimpio}" "${artistaPrincipal} - Topic"`,
        `"${artistaPrincipal} - ${tituloLimpio}" "Official Audio"`
      ]
    : [
        `"Provided to YouTube" "${tituloLimpio}"`,
        `"${tituloLimpio}" "Official Audio"`
      ];

  const consultaOriginal = consultasDiscograficas[1] || consultasDiscograficas[0];
  const consultaRescate = consultasDiscograficas[2] || `${artistaPrincipal} ${tituloLimpio} Official Audio`.trim();

  return {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultasDiscograficas,
    consultaOriginal,
    consultaRescate
  };
}

/**
 * Filtro de Autor/Canal Obligatorio:
 * DESCARTA DE INMEDIATO cualquier video cuyo canal (author.name) NO cumpla al menos una de estas condiciones:
 * 1) Termina en " - Topic" (canal autogenerado por la disquera).
 * 2) Contiene "VEVO" o "Official" / "Oficial".
 * 3) El nombre del canal contiene exactamente el nombre del artista principal (artista.toLowerCase()).
 */
function esCanalAutorOficialValido(autorRaw = '', artistaOriginal = '') {
  const autor = String(autorRaw || '').replace(/\u00a0/g, ' ').trim();
  if (!autor) return false;

  const autorLower = autor.toLowerCase();
  const autorNorm = normalizarTextoSimple(autor);

  // Condición 1: Termina en " - Topic" (o canal Topic autogenerado por YouTube Music / disquera)
  if (/-\s*topic$/i.test(autor) || /\btopic$/i.test(autor)) {
    return true;
  }

  // Condición 2 (v4.2.0): Contiene "VEVO" (ya NO se acepta cualquier canal con "Official"/"Oficial")
  if (/vevo/i.test(autorLower)) {
    return true;
  }

  // Condición 3: El nombre del canal contiene exactamente el nombre del artista principal
  const listaArtistas = String(artistaOriginal || '')
    .replace(/\u00a0/g, ' ')
    .split(/,|;|\/|&|\bfeat\.?\b|\bft\.?\b/i)
    .map((a) => a.trim())
    .filter((a) => a.length >= 2);

  for (const art of listaArtistas) {
    const artLower = art.toLowerCase();
    const artNorm = normalizarTextoSimple(art);
    if (artLower && autorLower.includes(artLower)) {
      return true;
    }
    if (artNorm && artNorm.length >= 3 && autorNorm.includes(artNorm)) {
      return true;
    }
  }

  return false;
}

/**
 * Lista Negra Estricta:
 * Rechaza cualquier resultado cuyo título o canal contenga:
 * cover, karaoke, instrumental, tribute, tributo, nightcore, sped up, slowed, 8d,
 * parodia, acústico, acoustic, session, live, en vivo, fan, version, letra, lyrics
 * (a menos que el título original de Spotify contenga explícitamente esa palabra).
 */
function esResultadoEnListaNegra(tituloCandidato = '', autorCandidato = '', tituloOriginalSpotify = '') {
  const origNorm = ` ${normalizarTextoSimple(tituloOriginalSpotify)} `;
  const candTexto = `${tituloCandidato || ''} ${autorCandidato || ''}`;
  const candNorm = ` ${normalizarTextoSimple(candTexto)} `;

  for (const palabra of PALABRAS_LISTA_NEGRA_ESTRICTA) {
    const palNorm = normalizarTextoSimple(palabra);
    if (!palNorm) continue;
    const regexPalabra = new RegExp(`\\b${palNorm.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (regexPalabra.test(candNorm) || regexPalabra.test(candTexto)) {
      // Verificar si el título original de Spotify contiene explícitamente esa palabra
      if (!regexPalabra.test(origNorm) && !regexPalabra.test(tituloOriginalSpotify || '')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Evalúa de forma estricta un candidato para asegurar que sea EXCLUSIVAMENTE
 * la grabación oficial de estudio del artista original.
 */
function evaluarCandidatoOriginal({
  tituloCandidato = '',
  autorCandidato = '',
  descripcionCandidato = '',
  duracionSegsCandidato = 0,
  tituloOriginal = '',
  artistaOriginal = '',
  duracionRefSegs = 0,
  toleranciaMaxSegs = TOLERANCIA_DURACION_OFICIAL_SEGS
}) {
  const canalValido = esCanalAutorOficialValido(autorCandidato, artistaOriginal);
  const enListaNegra = esResultadoEnListaNegra(tituloCandidato, autorCandidato, tituloOriginal);

  // Validación de Duración Exacta: Si Spotify proporcionó duracionSegundos > 0,
  // rechaza cualquier resultado cuya duración difiera en más de ±4 segundos (elimina videoclips con intros hablados o créditos finales).
  const tieneDuracionSpotify = duracionRefSegs > 0;
  const diffSegs =
    tieneDuracionSpotify && duracionSegsCandidato > 0
      ? Math.abs(duracionSegsCandidato - duracionRefSegs)
      : 0;
  const dentroToleranciaDuracion =
    !tieneDuracionSpotify ||
    (duracionSegsCandidato > 0 && diffSegs <= toleranciaMaxSegs);

  const normTituloCand = normalizarTextoSimple(tituloCandidato);
  const normAutorCand = normalizarTextoSimple(autorCandidato);
  const normTituloOrig = normalizarTextoSimple(limpiarTituloParaRescate(tituloOriginal) || tituloOriginal);
  const palabrasTitulo = normTituloOrig.split(' ').filter((w) => w.length >= 2);
  const palabrasCoincidentes = palabrasTitulo.filter((w) => normTituloCand.includes(w));
  const coincideTitulo =
    !normTituloOrig ||
    normTituloCand.includes(normTituloOrig) ||
    (palabrasTitulo.length > 0 && palabrasCoincidentes.length >= Math.ceil(palabrasTitulo.length * 0.7));

  const esTopicDisquera =
    /-\s*topic$/i.test(String(autorCandidato || '').trim()) ||
    /provided to youtube by/i.test(descripcionCandidato || '');
  const esVevoOficial = /\b(vevo|official|oficial)\b/i.test(autorCandidato || '');
  const esOfficialAudioTitle = /\b(official\s*audio|audio\s*oficial)\b/i.test(tituloCandidato || '');

  const esAutenticoEstudio =
    canalValido &&
    !enListaNegra &&
    dentroToleranciaDuracion &&
    coincideTitulo;

  let penalizacion = diffSegs * 1000;
  if (!canalValido) penalizacion += 1000000;
  if (enListaNegra) penalizacion += 1000000;
  if (!dentroToleranciaDuracion) penalizacion += 500000 + diffSegs * 5000;
  if (!coincideTitulo) penalizacion += 200000;

  // Prioridad 1 absoluta a grabaciones directas de distribución discográfica pura (" - Topic" / "Provided to YouTube by")
  if (esTopicDisquera) penalizacion -= 150000;
  if (esOfficialAudioTitle) penalizacion -= 15000;
  if (esVevoOficial) penalizacion -= 8000;
  if (normAutorCand && artistaOriginal && normAutorCand.includes(normalizarTextoSimple(artistaOriginal.split(',')[0]))) {
    penalizacion -= 6000;
  }

  return {
    esAutenticoEstudio,
    canalValido,
    enListaNegra,
    dentroToleranciaDuracion,
    coincideTitulo,
    esTopicDisquera,
    diffSegs,
    penalizacion
  };
}

// ---------------------------------------------------------------------------
// SoundCloud ELIMINADO de la búsqueda (v4.2.0). Solo se conserva el muxer HLS por compatibilidad del proxy.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// NIVEL 1: Extractor nativo @distube/ytdl-core (Directo de YouTube)
// ---------------------------------------------------------------------------
async function resolverNativoYtdl(videoUrl) {
  try {
    console.log(`[Nivel 1 Nativo]: Extrayendo formatos con @distube/ytdl-core...`);
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

    // Preferir M4A (itag 140 / audio/mp4) por compatibilidad universal, luego mayor bitrate
    lista.sort((a, b) => {
      const aM4a = String(a.mimeType || '').includes('audio/mp4') ? 1 : 0;
      const bM4a = String(b.mimeType || '').includes('audio/mp4') ? 1 : 0;
      if (bM4a !== aM4a) return bM4a - aM4a;
      return (b.audioBitrate || 0) - (a.audioBitrate || 0);
    });
    const mejorFormato = lista[0];

    if (mejorFormato && mejorFormato.url) {
      const bitrate = mejorFormato.audioBitrate || 128;
      console.log(`[Nivel 1 Éxito]: Stream nativo resuelto (${bitrate} kbps, itag ${mejorFormato.itag || '?'})`);
      return {
        url: mejorFormato.url,
        calidad: `${bitrate}k`,
        nivel: 1,
        proveedor: 'ytdl-native-stream'
      };
    }
  } catch (err) {
    console.warn(`[Nivel 1 Aviso]: ytdl-core no pudo extraer enlace:`, err.message || err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 2: SoundCloud API v2 (Streams progresivos MP3 o HLS sin cifrado)
// ---------------------------------------------------------------------------
let scClientIdCache = { id: null, fetchedAt: 0 };

async function obtenerSoundCloudClientId() {
  if (scClientIdCache.id && Date.now() - scClientIdCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return scClientIdCache.id;
  }
  try {
    const html = await axios.get('https://soundcloud.com', {
      timeout: 5000,
      headers: { 'User-Agent': UA }
    });
    const scripts = [...String(html.data || '').matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    for (const sUrl of scripts.slice(-5)) {
      try {
        const js = await axios.get(sUrl, { timeout: 5000 });
        const m = String(js.data || '').match(/client_id\s*:\s*"([a-zA-Z0-9]{20,40})"/);
        if (m && m[1]) {
          scClientIdCache = { id: m[1], fetchedAt: Date.now() };
          return m[1];
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function resolverSoundCloudDirecto(titulo = '', artista = '', duracionRef = 0) {
  const q = `${artista} ${titulo}`.trim();
  if (!q) return null;
  try {
    const clientId = await obtenerSoundCloudClientId();
    if (!clientId) return null;

    const sr = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q, client_id: clientId, limit: 10 },
      timeout: 6000,
      headers: { 'User-Agent': UA }
    });
    const tracks = Array.isArray(sr.data?.collection) ? sr.data.collection : [];
    const normTit = normalizarTextoSimple(limpiarTituloParaRescate(titulo) || titulo);
    const normArt = normalizarTextoSimple(artista.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0] || artista);

    for (const tr of tracks) {
      if (!tr || !tr.media || !Array.isArray(tr.media.transcodings)) continue;
      const durSeg = Math.round((Number(tr.duration) || 0) / 1000);
      if (durSeg < 45) continue; // Ignorar previews de 30s
      if (duracionRef > 0 && Math.abs(durSeg - duracionRef) > 20) continue;

      const tNorm = normalizarTextoSimple(tr.title || '');
      const uNorm = normalizarTextoSimple(tr.user?.username || '');
      const palabrasTit = normTit.split(' ').filter((w) => w.length >= 2);
      const coincidenciasTit = palabrasTit.filter((w) => tNorm.includes(w));
      if (palabrasTit.length > 0 && coincidenciasTit.length < Math.ceil(palabrasTit.length * 0.7)) continue;
      if (/\b(edit|mashup|megamix|cocktail|slowed|reverb|sped up)\b/i.test(tr.title || '') && !/\b(edit|mashup|slowed|reverb)\b/i.test(titulo || '')) continue;
      if (esResultadoEnListaNegra(tr.title || '', tr.user?.username || '', titulo)) continue;
      if (normArt && !tNorm.includes(normArt) && !uNorm.includes(normArt)) continue;

      // Buscar transcoding NO cifrado y NO snipped (progressive MP3 primero, luego HLS)
      const transcoding =
        tr.media.transcodings.find((t) => !t.snipped && t.format?.protocol === 'progressive') ||
        tr.media.transcodings.find((t) => !t.snipped && t.format?.protocol === 'hls');

      if (!transcoding || !transcoding.url) continue;

      const streamResp = await axios.get(transcoding.url, {
        params: { client_id: clientId },
        timeout: 5000,
        headers: { 'User-Agent': UA }
      });

      if (streamResp.data && streamResp.data.url) {
        const esHls = transcoding.format?.protocol === 'hls';
        console.log(`[Nivel 2 SoundCloud Éxito]: "${tr.title}" (${durSeg}s, ${esHls ? 'HLS' : 'MP3'})`);
        return {
          url: streamResp.data.url,
          calidad: '160k',
          nivel: 2,
          proveedor: 'SoundCloud-Direct',
          esHlsSoundCloud: esHls
        };
      }
    }
  } catch (errSc) {
    console.warn('[Nivel 2 SoundCloud Aviso]:', errSc.message || errSc);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 3: Audius Discovery API (MP3 completos gratuitos)
// ---------------------------------------------------------------------------
async function resolverAudiusDirecto(titulo = '', artista = '', duracionRef = 0) {
  const q = `${artista} ${titulo}`.trim();
  if (!q) return null;
  try {
    const r = await axios.get('https://discoveryprovider.audius.co/v1/tracks/search', {
      params: { query: q, app_name: 'AppMusica' },
      timeout: 6000,
      headers: { 'User-Agent': UA }
    });
    const lista = Array.isArray(r.data?.data) ? r.data.data : [];
    const normTit = normalizarTextoSimple(limpiarTituloParaRescate(titulo) || titulo);
    const normArt = normalizarTextoSimple(artista.split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0] || artista);

    for (const tr of lista.slice(0, 8)) {
      if (!tr || !tr.id || !tr.is_streamable) continue;
      const durSeg = Number(tr.duration) || 0;
      if (durSeg < 45) continue;
      if (duracionRef > 0 && Math.abs(durSeg - duracionRef) > 20) continue;

      const tNorm = normalizarTextoSimple(tr.title || '');
      const uNorm = normalizarTextoSimple(tr.user?.name || '');
      if (normTit && !tNorm.includes(normTit.split(' ')[0])) continue;
      if (esResultadoEnListaNegra(tr.title || '', tr.user?.name || '', titulo)) continue;
      if (normArt && !tNorm.includes(normArt) && !uNorm.includes(normArt)) continue;

      const streamUrl = `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(tr.id)}/stream?app_name=AppMusica`;
      console.log(`[Nivel 3 Audius Éxito]: "${tr.title}" (${durSeg}s)`);
      return {
        url: streamUrl,
        calidad: '320k',
        nivel: 3,
        proveedor: 'Audius-Direct'
      };
    }
  } catch (errAud) {
    console.warn('[Nivel 3 Audius Aviso]:', errAud.message || errAud);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 4: Internet Archive (MP3 de dominio público / archivos abiertos)
// ---------------------------------------------------------------------------
async function resolverInternetArchiveDirecto(titulo = '', artista = '') {
  const q = `${artista} ${titulo}`.trim();
  if (!q) return null;
  try {
    const InternetArchiveSource = require('../sources/InternetArchiveSource');
    const ia = new InternetArchiveSource();
    const resultados = await ia.search(q, 5);
    const normTit = normalizarTextoSimple(limpiarTituloParaRescate(titulo) || titulo);
    for (const item of resultados) {
      if (!item || !item.videoId) continue;
      if (esResultadoEnListaNegra(item.title || '', item.artist || '', titulo)) continue;
      const tNorm = normalizarTextoSimple(item.title || '');
      if (normTit && !tNorm.includes(normTit.split(' ')[0])) continue;
      const streamInfo = await ia.getStream(item.videoId);
      if (streamInfo && streamInfo.downloadUrl) {
        console.log(`[Nivel 4 Internet Archive Éxito]: "${item.title}"`);
        return {
          url: streamInfo.downloadUrl,
          calidad: '192k',
          nivel: 4,
          proveedor: 'InternetArchive-Direct'
        };
      }
    }
  } catch (errIa) {
    console.warn('[Nivel 4 IA Aviso]:', errIa.message || errIa);
  }
  return null;
}

// ---------------------------------------------------------------------------
// BÚSQUEDA EXCLUSIVA EN YOUTUBE MUSIC: CATEGORÍA SONG (PISTAS DDEX DE ESTUDIO)
// Cero búsqueda de videos generales (ni yt-search ni Invidious video search)
// ---------------------------------------------------------------------------
async function buscarVideoOriginalEnYouTube(tituloRaw = '', artistaRaw = '', duracionSpotifySegs = 0, isrc = '') {
  const {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal
  } = construirConsultasOriginalYRescate(tituloRaw, artistaRaw);

  // 1. Consultar primero la duración exacta del máster en Deezer (ISRC o búsqueda) / iTunes
  let master = null;
  if (isrc || (artistaPrincipal && tituloLimpio)) {
    try {
      master = await obtenerMasterOficial(tituloLimpio, artistaPrincipal, Number(duracionSpotifySegs) || 0, isrc);
    } catch (_) {
      master = null;
    }
  }
  const duracionRefSegs = resolverDuracionReferencia(duracionSpotifySegs, master);
  const artistasAceptados = [artista, artistaPrincipal, master && master.artistaCanonico]
    .filter(Boolean)
    .flatMap((a) => String(a).split(/,|;|\/|&|\bfeat\.?\b|\bft\.?\b/i))
    .map((a) => normalizarTextoSimple(a))
    .filter((a) => a.length >= 2);

  console.log(`[YTMusic-DDEX v4.5.0]: "${artistaPrincipal} - ${tituloLimpio}" | Spotify: ${duracionSpotifySegs || 0}s | Máster: ${master ? `${master.duracionOficialSeg}s (${master.fuente})` : 'N/D'} | Ref estricta: ${duracionRefSegs}s ±${TOLERANCIA_DURACION_OFICIAL_SEGS}s`);

  // 2. Consultar EXCLUSIVAMENTE ytmusic.searchSongs(...) (categoría SONG DDEX)
  let ytmusic = null;
  let ytmusicFallo = false;
  try {
    ytmusic = await obtenerClienteYTMusic();
  } catch (errInit) {
    ytmusicFallo = true;
    console.warn('[Studio-Pure]: ytmusic-api falló al inicializar, activando respaldo estricto - Topic:', errInit.message);
  }

  const consultas = [];
  const qPrincipal = `${artistaPrincipal} ${tituloLimpio}`.trim();
  if (qPrincipal) consultas.push(qPrincipal);
  const qCompleta = `${artista} ${titulo}`.trim();
  if (qCompleta && qCompleta.toLowerCase() !== qPrincipal.toLowerCase()) consultas.push(qCompleta);

  const normTituloOrig = normalizarTextoSimple(tituloLimpio || titulo);
  const palabrasTitulo = normTituloOrig.split(' ').filter((w) => w.length >= 2);

  const candidatosValidos = [];
  const candidatosRelajados = [];
  const vistos = new Set();

  if (ytmusic) {
    for (const q of consultas) {
      let songs = [];
      try {
        songs = await ytmusic.searchSongs(q);
      } catch (errSearch) {
        ytmusicFallo = true;
        console.warn(`[Studio-Pure]: Falló searchSongs("${q}"):`, errSearch.message);
        continue;
      }

      if (!Array.isArray(songs) || songs.length === 0) {
        ytmusicFallo = true;
      }

      for (const song of songs || []) {
        if (!song || song.type !== 'SONG' || !song.videoId || vistos.has(song.videoId)) continue;
        vistos.add(song.videoId);

        const songTitle = String(song.name || '').trim();
        const songArtists = [];
        if (song.artist && song.artist.name) songArtists.push(song.artist.name);
        if (Array.isArray(song.artists)) {
          for (const a of song.artists) {
            if (a && a.name) songArtists.push(a.name);
          }
        }
        const songArtistText = Array.from(new Set(songArtists)).join(', ');
        const songDuration = Number(song.duration) || 0;

        if (esResultadoEnListaNegra(songTitle, songArtistText, titulo)) continue;

        const normSongArtist = normalizarTextoSimple(songArtistText);
        const artistaCoincide =
          artistasAceptados.length === 0 ||
          artistasAceptados.some((art) => normSongArtist && (normSongArtist.includes(art) || art.includes(normSongArtist)));
        if (!artistaCoincide) continue;

        const normSongTitle = normalizarTextoSimple(songTitle);
        const palabrasCoinciden = palabrasTitulo.filter((w) => normSongTitle.includes(w));
        const tituloCoincide =
          !normTituloOrig ||
          normSongTitle.includes(normTituloOrig) ||
          normTituloOrig.includes(normSongTitle) ||
          (palabrasTitulo.length > 0 && palabrasCoinciden.length >= Math.ceil(palabrasTitulo.length * 0.7));
        if (!tituloCoincide) continue;

        // Tolerancia estricta ±2 segundos respecto a duracionMasterSeg; guardar respaldo hasta ±20s
        const diffSegs = duracionRefSegs > 0 ? Math.abs(songDuration - duracionRefSegs) : 0;
        if (duracionRefSegs > 0 && (songDuration <= 0 || diffSegs > TOLERANCIA_DURACION_OFICIAL_SEGS)) {
          if (songDuration > 0 && diffSegs <= 20) {
            candidatosRelajados.push({
              song,
              songTitle,
              songArtistText,
              songDuration,
              diffSegs
            });
          }
          continue;
        }

        candidatosValidos.push({
          song,
          songTitle,
          songArtistText,
          songDuration,
          diffSegs
        });
      }

      if (candidatosValidos.length > 0) break;
    }
  }

  // 3. Respaldo robusto con yt-search cuando ytmusic-api falla o devuelve vacío:
  // Prioriza canales "- Topic" / "Provided to YouTube by" / VEVO / artista oficial, y como respaldo
  // acepta audios limpios en YouTube (sin cover/karaoke/live) que coincidan en título, artista y duración.
  if (candidatosValidos.length === 0 && (tituloLimpio || titulo)) {
    const baseArt = artistaPrincipal || artista || '';
    const baseTit = tituloLimpio || titulo;
    const consultasYt = baseArt
      ? [
          `${baseArt} ${baseTit} Topic`,
          `${baseArt} ${baseTit} Official Audio`,
          `${baseArt} ${baseTit}`
        ]
      : [
          `${baseTit} Official Audio`,
          `${baseTit}`
        ];

    for (const qYt of consultasYt) {
      try {
        const resYt = await yts(qYt);
        const videos = resYt && Array.isArray(resYt.videos) ? resYt.videos : [];
        for (const v of videos.slice(0, 12)) {
          if (!v || !v.videoId || vistos.has(v.videoId)) continue;
          vistos.add(v.videoId);

          const autorNombre = String((v.author && v.author.name) || v.author || '').trim();
          const desc = String(v.description || '');
          const tituloVid = String(v.title || '').trim();
          const durVid = Number(v.seconds) || 0;
          if (durVid > 0 && (durVid < 45 || durVid > 720)) continue;

          if (esResultadoEnListaNegra(tituloVid, autorNombre, titulo)) continue;

          const normVidTitle = normalizarTextoSimple(tituloVid);
          const normAutor = normalizarTextoSimple(autorNombre);
          const palabrasCoinciden = palabrasTitulo.filter((w) => normVidTitle.includes(w));
          const tituloCoincide =
            !normTituloOrig ||
            normVidTitle.includes(normTituloOrig) ||
            (palabrasTitulo.length > 0 && palabrasCoinciden.length >= Math.ceil(palabrasTitulo.length * 0.65));
          if (!tituloCoincide) continue;

          const artistaEnTituloOAutor =
            artistasAceptados.length === 0 ||
            artistasAceptados.some((art) => (normAutor && normAutor.includes(art)) || normVidTitle.includes(art));
          if (!artistaEnTituloOAutor) continue;

          const esCanalOficial =
            autorNombre.endsWith(' - Topic') ||
            desc.includes('Provided to YouTube by') ||
            /vevo/i.test(autorNombre) ||
            artistasAceptados.some((art) => normAutor && normAutor.includes(art));

          if (!esCanalOficial) continue;

          const diffSegs = duracionRefSegs > 0 && durVid > 0 ? Math.abs(durVid - duracionRefSegs) : 0;
          const esOfficialAudio = /\b(official\s*audio|audio\s*oficial|topic)\b/i.test(`${tituloVid} ${autorNombre}`);

          if (duracionRefSegs === 0 || diffSegs <= 6) {
            candidatosValidos.push({
              song: { videoId: v.videoId },
              songTitle: tituloVid || baseTit,
              songArtistText: autorNombre || baseArt,
              songDuration: durVid,
              diffSegs: diffSegs - (esOfficialAudio ? 2 : 0)
            });
          } else if (diffSegs <= 20) {
            candidatosRelajados.push({
              song: { videoId: v.videoId },
              songTitle: tituloVid || baseTit,
              songArtistText: autorNombre || baseArt,
              songDuration: durVid,
              diffSegs: diffSegs - (esOfficialAudio ? 2 : 0)
            });
          }
        }
        if (candidatosValidos.length > 0) break;
      } catch (_) {}
    }
  }

  const listaFinal = candidatosValidos.length > 0 ? candidatosValidos : candidatosRelajados;

  // 4. Si ningún resultado cumple estas condiciones, devolver null
  if (listaFinal.length === 0) {
    console.warn(`[Studio-Pure]: Pista oficial de estudio no disponible para "${artistaPrincipal} - ${tituloLimpio}"`);
    return null;
  }

  listaFinal.sort((a, b) => a.diffSegs - b.diffSegs);
  const elegido = listaFinal[0];
  console.log(`[YTMusic-DDEX Éxito]: "${elegido.songTitle}" | Artista: "${elegido.songArtistText}" | ${elegido.songDuration}s (Ref: ${duracionRefSegs}s, diff: ${elegido.diffSegs}s) | videoId: ${elegido.song.videoId}`);

  return {
    videoId: elegido.song.videoId,
    title: elegido.songTitle,
    seconds: elegido.songDuration || duracionRefSegs,
    author: { name: elegido.songArtistText || artistaPrincipal },
    esVerificadoOficial: true,
    duracionRefVerificada: duracionRefSegs
  };
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA (YouTube + SoundCloud + Audius + Internet Archive)
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3', opciones = {}) {
  const formato = normalizarFormato(formatoDeseado);
  const estricto = Boolean(opciones.estricto || video?.estricto);
  const omitir = new Set(Array.isArray(opciones.omitirProveedores) ? opciones.omitirProveedores : []);
  const duracionRef = video?.duracionRef || video?.seconds || 0;
  const artistaOriginal = video?.artistaOriginal || (video?.author && video.author.name) || '';
  const tituloOriginal = video?.tituloOriginal || busqueda || video?.title || '';
  const isrc = video?.isrc || opciones.isrc || '';

  const {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultaOriginal
  } = construirConsultasOriginalYRescate(tituloOriginal, artistaOriginal);

  const tieneVideoIdDirecto = Boolean(
    video &&
    video.videoId &&
    video.videoId.length === 11 &&
    !video.videoId.startsWith('itunes_')
  );

  let videoOficial = video;
  if (!videoOficial || (!videoOficial.esVerificadoOficial && (estricto || !tieneVideoIdDirecto))) {
    videoOficial = await buscarVideoOriginalEnYouTube(titulo, artista, duracionRef, isrc);
  }

  const esYouTubeValido = Boolean(
    videoOficial &&
    videoOficial.videoId &&
    videoOficial.videoId.length === 11 &&
    !videoOficial.videoId.startsWith('itunes_')
  );

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Oficial Estudio]: Resolviendo "${consultaOriginal}" (VideoID: ${esYouTubeValido ? videoOficial.videoId : 'N/A'}, Canal: "${videoOficial?.author?.name || 'N/A'}", DurRef: ${videoOficial?.duracionRefVerificada || duracionRef}s, estricto: ${estricto})`);

  // 1. Extractor nativo @distube/ytdl-core sobre el video de YouTube (si no está omitido)
  if (esYouTubeValido && !omitir.has('ytdl-native-stream')) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoOficial.videoId}`;
    try {
      const resYtdl = await Promise.race([
        resolverNativoYtdl(videoUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1 YTDL Timeout 8s')), 8000))
      ]);
      if (resYtdl && resYtdl.url) return resYtdl;
    } catch (e1) {
      console.warn(`[Nivel 1 YTDL Oficial]: Falló para ${videoOficial.videoId} (${e1.message})`);
    }

    // Si el videoId vino del cliente y falló, intentar localizar otro videoId oficial alternativo
    if (!estricto && !videoOficial.esVerificadoOficial && (titulo || artista)) {
      try {
        const altVid = await buscarVideoOriginalEnYouTube(titulo, artista, duracionRef, isrc);
        if (altVid && altVid.videoId && altVid.videoId !== videoOficial.videoId) {
          const resAltYtdl = await Promise.race([
            resolverNativoYtdl(`https://www.youtube.com/watch?v=${altVid.videoId}`),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1B YTDL Timeout 8s')), 8000))
          ]);
          if (resAltYtdl && resAltYtdl.url) return resAltYtdl;
        }
      } catch (_) {}
    }
  }

  const titBusq = tituloLimpio || titulo || busqueda;
  const artBusq = artistaPrincipal || artista || '';
  const durBusq = videoOficial?.duracionRefVerificada || duracionRef || 0;

  // En modo estricto (importación de Spotify), NUNCA sustituir con SoundCloud/Audius/IA
  // para evitar descargar covers, imitadores o audios con otra voz.
  if (estricto) {
    console.warn(`[Cascada Oficial]: Modo estricto activo — omitiendo fuentes no oficiales para "${artBusq} - ${titBusq}".`);
    return null;
  }

  // 2. SoundCloud API v2 (Streams MP3/HLS sin cifrado)
  if (!omitir.has('SoundCloud-Direct')) {
    try {
      const resSc = await resolverSoundCloudDirecto(titBusq, artBusq, durBusq);
      if (resSc && resSc.url) return resSc;
    } catch (e2) {
      console.warn(`[Nivel 2 SoundCloud]: Pasando a Nivel 3 (${e2.message})`);
    }
  }

  // 3. Audius Discovery API (MP3 completos)
  if (!omitir.has('Audius-Direct')) {
    try {
      const resAud = await resolverAudiusDirecto(titBusq, artBusq, durBusq);
      if (resAud && resAud.url) return resAud;
    } catch (e3) {
      console.warn(`[Nivel 3 Audius]: Pasando a Nivel 4 (${e3.message})`);
    }
  }

  // 4. Internet Archive (MP3 de dominio público / archivos abiertos)
  if (!omitir.has('InternetArchive-Direct')) {
    try {
      const resIa = await resolverInternetArchiveDirecto(titBusq, artBusq);
      if (resIa && resIa.url) return resIa;
    } catch (e4) {
      console.warn(`[Nivel 4 IA]: Falló (${e4.message})`);
    }
  }

  console.error(`[Cascada Oficial]: No se pudo extraer el audio para "${artBusq} - ${titBusq}".`);
  return null;
}

/**
 * Busca hasta 4 candidatos reales en YouTube Music (ytmusic-api) y YouTube (yt-search)
 * limpiando sufijos numéricos (_174232...) y priorizando canales - Topic / Provided to YouTube by / artista oficial.
 */
async function buscarCandidatosOficiales(tituloRaw = '', artistaRaw = '', duracionSegundos = 0) {
  const limpiarSufijoNumerico = (txt = '') =>
    String(txt || '')
      .replace(/_\d{6,}/g, ' ')
      .replace(/\b\d{10,}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const tituloBase = limpiarSufijoNumerico(tituloRaw);
  const artistaBase = limpiarSufijoNumerico(artistaRaw);
  const { titulo, tituloLimpio, artista, artistaPrincipal } = construirConsultasOriginalYRescate(tituloBase, artistaBase);

  const qBusqueda = `${artistaPrincipal || artista} ${tituloLimpio || titulo}`.trim() || tituloBase;
  const candidatos = [];
  const vistos = new Set();

  const agregarCandidato = ({ videoId, tituloCand, canal, duracionSeg, esTopicOOficial, prioridad }) => {
    if (!videoId || videoId.length !== 11 || vistos.has(videoId)) return;
    if (duracionSeg > 0 && (duracionSeg < 45 || duracionSeg > 720)) return;
    vistos.add(videoId);
    const diff = duracionSegundos > 0 && duracionSeg > 0 ? Math.abs(duracionSeg - duracionSegundos) : 0;
    candidatos.push({
      videoId,
      titulo: String(tituloCand || tituloLimpio || tituloBase).trim(),
      canal: String(canal || 'YouTube Music').trim(),
      duracionSeg: Number(duracionSeg) || 0,
      esOficial: Boolean(esTopicOOficial),
      _score: (esTopicOOficial ? 0 : 1000) + prioridad * 50 + diff
    });
  };

  // 1) YouTube Music (ytmusic-api categoría SONG DDEX)
  try {
    const ytmusic = await obtenerClienteYTMusic();
    const songs = await ytmusic.searchSongs(qBusqueda);
    for (const s of (songs || []).slice(0, 6)) {
      if (!s || !s.videoId) continue;
      const artNames = [];
      if (s.artist && s.artist.name) artNames.push(s.artist.name);
      if (Array.isArray(s.artists)) {
        for (const a of s.artists) if (a && a.name) artNames.push(a.name);
      }
      const canal = artNames.length ? `${Array.from(new Set(artNames)).join(', ')} - Topic` : 'YouTube Music - Topic';
      agregarCandidato({
        videoId: s.videoId,
        tituloCand: s.name,
        canal,
        duracionSeg: Number(s.duration) || 0,
        esTopicOOficial: true,
        prioridad: 0
      });
    }
  } catch (eYtm) {
    console.warn('[buscarCandidatosOficiales ytmusic]:', eYtm.message);
  }

  // 2) YouTube (yt-search) priorizando canales - Topic / Provided to YouTube by / artista oficial
  const consultasYt = [
    `"${tituloLimpio || tituloBase}" "${artistaPrincipal || artistaBase} - Topic"`,
    `${artistaPrincipal || artistaBase} ${tituloLimpio || tituloBase} Official Audio`.trim()
  ];
  for (let idx = 0; idx < consultasYt.length; idx++) {
    try {
      const r = await yts(consultasYt[idx]);
      for (const v of (r && r.videos ? r.videos : []).slice(0, 8)) {
        if (!v || !v.videoId) continue;
        const canal = String((v.author && v.author.name) || v.author || '').trim();
        const desc = String(v.description || '');
        const esTopic = canal.endsWith(' - Topic') || desc.includes('Provided to YouTube by');
        const esArtistaOficial =
          esTopic ||
          /vevo/i.test(canal) ||
          (artistaPrincipal && normalizarTextoSimple(canal).includes(normalizarTextoSimple(artistaPrincipal)));
        agregarCandidato({
          videoId: v.videoId,
          tituloCand: v.title,
          canal,
          duracionSeg: Number(v.seconds) || 0,
          esTopicOOficial: esArtistaOficial,
          prioridad: esTopic ? 1 : idx + 2
        });
      }
    } catch (_) {}
  }

  candidatos.sort((a, b) => a._score - b._score);
  return candidatos.slice(0, 4).map(({ _score, ...rest }) => rest);
}

module.exports = {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato,
  getTimeoutSignal,
  buscarVideoOriginalEnYouTube,
  buscarCandidatosOficiales,
  construirConsultasOriginalYRescate,
  limpiarTituloParaRescate,
  evaluarCandidatoOriginal,
  esResultadoEnListaNegra,
  esCanalAutorOficialValido,
  obtenerMasterOficial,
  resolverDuracionReferencia,
  TOLERANCIA_DURACION_OFICIAL_SEGS
};
