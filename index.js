const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
const PUERTO = 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('¡El motor de descargas está activo y sin bloqueos!');
});

app.get('/descargar', (req, res) => {
  const busqueda = req.query.q;

  if (!busqueda) {
    return res.status(400).send('Debes enviar el nombre de una canción.');
  }

  console.log(`Buscando en catálogo completo: ${busqueda}...`);

  // Formato nativo para que el reproductor web y el celular lo lean perfecto
  res.header('Content-Type', 'audio/mp4');
  res.header('Content-Disposition', `attachment; filename="cancion.mp4"`);

  // EL MOTOR TIPO "SPOTIFY": Busca en YouTube con el máximo escudo anti-bloqueos
  const proceso = ytDlp.exec(`ytsearch1:${busqueda}`, {
    format: 'bestaudio', 
    forceIpv4: true, // Truco maestro 1: Salta el bloqueo de IPs de Render
    extractorArgs: 'youtube:player_client=android', // Truco maestro 2: Se disfraza de celular Android
    output: '-' 
  }, { stdio: ['ignore', 'pipe', 'inherit'] });

  proceso.stdout.pipe(res);
});

app.listen(PUERTO, () => {
  console.log(`Servidor activo y escuchando en http://localhost:${PUERTO}`);
});