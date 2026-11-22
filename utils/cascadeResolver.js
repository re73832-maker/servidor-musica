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

  // 1) Deezer API pública por artista + track
  if (!resultado && titulo && artista) {
    try {
      const q = `artist:"${artista}" track:"${titulo}"`;
      const r = await axios.get('https://api.deezer.com/search', {
        params: { q, limit: 5 },
        timeout: 6000,
        headers: { 'User-Agent': UA }
      });
      const lista = Array.isArray(r.data?.data) ? r.data.data : [];
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
// NIVEL 3: Invidious Adaptive Audio Directo (itag 140 M4A / 251 Opus de YouTube oficial)
// ---------------------------------------------------------------------------
async function resolverInvidiousDirecto(videoId) {
  if (!videoId || videoId.length !== 11) return null;
  const invidiousHosts = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.jing.rocks',
    'https://invidious.f5.si',
    'https://inv.tux.pizza'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, {
        signal: getTimeoutSignal(6000),
        timeout: 6000,
        headers: { 'User-Agent': UA }
      });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      formatos.sort((a, b) => {
        const bitDiff = (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
        if (bitDiff !== 0) return bitDiff;
        const aM4a = String(a.type || '').includes('audio/mp4') ? 1 : 0;
        const bM4a = String(b.type || '').includes('audio/mp4') ? 1 : 0;
        return bM4a - aM4a;
      });
      const mejor =
        formatos[0] ||
        formatos.find((f) => String(f.itag) === '141') ||
        formatos.find((f) => String(f.itag) === '140') ||
        formatos.find((f) => String(f.itag) === '251');
      if (mejor && mejor.url) {
        const kbps = mejor.bitrate ? `${Math.round(Number(mejor.bitrate) / 1000)}k` : '160k';
        console.log(`[Invidious Oficial Éxito]: Resuelto audio original Hi-Fi (${videoId}, ${kbps}) vía ${host}`);
        return {
          url: mejor.url,
          calidad: kbps,
          nivel: 3,
          proveedor: 'Invidious-Official-Audio'
        };
      }
    } catch (_) {}
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

        // Tolerancia estricta ±2 segundos respecto a duracionMasterSeg
        const diffSegs = duracionRefSegs > 0 ? Math.abs(songDuration - duracionRefSegs) : 0;
        if (duracionRefSegs > 0 && (songDuration <= 0 || diffSegs > TOLERANCIA_DURACION_OFICIAL_SEGS)) {
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

  // 3. Respaldo ÚNICAMENTE si ytmusic-api falló en Render (bloqueo regional / vacío):
  // Canales autogenerados por disquera (" - Topic" / "Provided to YouTube by") con tolerancia estricta ±2s
  if (candidatosValidos.length === 0 && ytmusicFallo && artistaPrincipal && tituloLimpio) {
    const consultasTopic = [
      `"${tituloLimpio}" "${artistaPrincipal} - Topic"`,
      `"Provided to YouTube by" "${tituloLimpio}" "${artistaPrincipal}"`
    ];
    for (const qTopic of consultasTopic) {
      try {
        const resTopic = await yts(qTopic);
        const videos = resTopic && Array.isArray(resTopic.videos) ? resTopic.videos : [];
        for (const v of videos) {
          if (!v || !v.videoId || vistos.has(v.videoId)) continue;
          vistos.add(v.videoId);

          const autorNombre = String((v.author && v.author.name) || v.author || '').trim();
          const desc = String(v.description || '');
          const esCanalTopicDisquera =
            autorNombre.endsWith(' - Topic') || desc.includes('Provided to YouTube by');
          if (!esCanalTopicDisquera) continue;

          if (esResultadoEnListaNegra(v.title || '', autorNombre, titulo)) continue;

          const normAutor = normalizarTextoSimple(autorNombre);
          const artistaCoincide =
            artistasAceptados.length === 0 ||
            artistasAceptados.some((art) => normAutor && normAutor.includes(art));
          if (!artistaCoincide) continue;

          const normVidTitle = normalizarTextoSimple(v.title || '');
          const palabrasCoinciden = palabrasTitulo.filter((w) => normVidTitle.includes(w));
          const tituloCoincide =
            !normTituloOrig ||
            normVidTitle.includes(normTituloOrig) ||
            (palabrasTitulo.length > 0 && palabrasCoinciden.length >= Math.ceil(palabrasTitulo.length * 0.7));
          if (!tituloCoincide) continue;

          const durVid = Number(v.seconds) || 0;
          const diffSegs = duracionRefSegs > 0 ? Math.abs(durVid - duracionRefSegs) : 0;
          if (duracionRefSegs > 0 && (durVid <= 0 || diffSegs > TOLERANCIA_DURACION_OFICIAL_SEGS)) {
            continue;
          }

          candidatosValidos.push({
            song: { videoId: v.videoId },
            songTitle: v.title || tituloLimpio,
            songArtistText: autorNombre,
            songDuration: durVid,
            diffSegs
          });
        }
        if (candidatosValidos.length > 0) break;
      } catch (_) {}
    }
  }

  // 4. Cero Relleno: si ningún resultado cumple estas condiciones exactas, devolver null (-> 404)
  if (candidatosValidos.length === 0) {
    console.warn(`[Studio-Pure]: Pista oficial de estudio no disponible para "${artistaPrincipal} - ${tituloLimpio}"`);
    return null;
  }

  candidatosValidos.sort((a, b) => a.diffSegs - b.diffSegs);
  const elegido = candidatosValidos[0];
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
// FUNCIÓN MAESTRA EN CASCADA (CERO VIDEOS GENERALES / SOLO PISTAS SONG YTMUSIC)
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3', opciones = {}) {
  const formato = normalizarFormato(formatoDeseado);
  const estricto = Boolean(opciones.estricto || video?.estricto);
  const duracionRef = video?.duracionRef || video?.seconds || 0;
  const artistaOriginal = video?.artistaOriginal || (video?.author && video.author.name) || '';
  const tituloOriginal = video?.tituloOriginal || busqueda || video?.title || '';
  const isrc = video?.isrc || opciones.isrc || '';

  const {
    titulo,
    artista,
    consultaOriginal
  } = construirConsultasOriginalYRescate(tituloOriginal, artistaOriginal);

  let videoOficial = video;
  if (!videoOficial || !videoOficial.esVerificadoOficial) {
    videoOficial = await buscarVideoOriginalEnYouTube(titulo, artista, duracionRef, isrc);
  }

  const esYouTubeValido = Boolean(
    videoOficial &&
    videoOficial.videoId &&
    videoOficial.videoId.length === 11 &&
    !videoOficial.videoId.startsWith('itunes_')
  );
  if (!esYouTubeValido) {
    console.error(`[Cascada Oficial]: Audio oficial de estudio no disponible para "${artista} - ${titulo}".`);
    return null;
  }
  const videoUrl = `https://www.youtube.com/watch?v=${videoOficial.videoId}`;

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Oficial Estudio]: Resolviendo "${consultaOriginal}" (VideoID: ${videoOficial.videoId}, Canal: "${videoOficial?.author?.name || 'N/A'}", DurRef: ${videoOficial.duracionRefVerificada || duracionRef}s, estricto: ${estricto})`);

  // 1. Extractor nativo @distube/ytdl-core sobre el video OFICIAL verificado
  try {
    const resYtdl = await Promise.race([
      resolverNativoYtdl(videoUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1 YTDL Timeout 8s')), 8000))
    ]);
    if (resYtdl && resYtdl.url) return resYtdl;
  } catch (e1) {
    console.warn(`[Nivel 1 YTDL Oficial]: Pasando a Nivel 2 (${e1.message})`);
  }

  // 2. Loader / Savenow sobre el mismo video OFICIAL verificado
  try {
    const resLoader = await Promise.race([
      probarLoaderSavenow(videoUrl, formato),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 2 Loader Timeout 8s')), 8000))
    ]);
    if (resLoader && resLoader.url) return resLoader;
  } catch (e2) {
    console.warn(`[Nivel 2 Loader Oficial]: Pasando a Nivel 3 (${e2.message})`);
  }

  // 3. Invidious Adaptive Audio sobre el mismo videoId OFICIAL verificado
  try {
    const resInv = await resolverInvidiousDirecto(videoOficial.videoId);
    if (resInv && resInv.url) return resInv;
  } catch (e3) {
    console.warn(`[Nivel 3 Invidious Oficial]: Falló (${e3.message})`);
  }

  console.error(`[Cascada Oficial]: No se pudo extraer el audio del máster oficial "${artista} - ${titulo}".`);
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
