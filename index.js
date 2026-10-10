const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PUERTO = 4000;

app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('¡El motor de descargas de música está funcionando!');
});

// NUEVA RUTA: El motor que descarga la música
app.get('/descargar', (req, res) => {
  // Capturamos lo que tu papá escriba en el buscador (ej. ?q=vicente fernandez)
  const busqueda = req.query.q;

  if (!busqueda) {
    return res.status(400).send('Debes enviar el nombre de una canción.');
  }

  console.log(`Buscando y preparando audio de: ${busqueda}...`);

  // Le decimos al navegador que lo que va a recibir es un archivo de audio MP3
  res.header('Content-Type', 'audio/mpeg');
  res.header('Content-Disposition', `attachment; filename="cancion.mp3"`);

  // Ejecutamos yt-dlp: 'ytsearch1:' busca el primer video que coincida con el texto
  const proceso = ytDlp.exec(`ytsearch1:${busqueda}`, {
    extractAudio: true,
    audioFormat: 'mp3',
    output: '-', // El guion indica que el archivo se transmite en vivo, no se guarda en carpeta
  }, { stdio: ['ignore', 'pipe', 'ignore'] });

  // Conectamos el audio que se va descargando directo a la respuesta de tu servidor
  proceso.stdout.pipe(res);
});

// Iniciar el servidor
app.listen(PUERTO, () => {
  console.log(`Servidor activo y escuchando en http://localhost:${PUERTO}`);
});