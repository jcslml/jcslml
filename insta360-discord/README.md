# Puente de directo: Insta360 GO Ultra → Discord

Aplicación que recibe el directo de la cámara y lo lleva a Discord:

- **Aviso automático** en un canal cuando empiezas a emitir, con una imagen que se renueva sola y el enlace para verlo; al terminar, lo marca como finalizado.
- **Visor web de baja latencia** (≈1 s de retraso) que funciona en móvil y ordenador.
- **Actividad de Discord**: el directo se ve *dentro* del canal de voz, solo para miembros de tu servidor.
- **Panel de control** en español con todo lo que hay que copiar y pegar.

```
Cámara ──RTMP──▶ Puente (este programa) ──▶ Aviso en un canal de Discord
 (Wi‑Fi 5 GHz,                           ├─▶ Visor web (enlace privado)
  p. ej. el punto                        └─▶ Actividad en el canal de voz
  de acceso del móvil)
```

## Antes de nada: lo que se puede y lo que no

1. **La GO Ultra no funciona como webcam** y **Discord no deja que un bot emita vídeo** en un canal de voz. Por eso no existe una app que "conecte" la cámara a una llamada de Discord directamente; este puente es la vía que respeta las normas de Discord. (Hay programas que lo simulan automatizando una cuenta de usuario; van contra los términos de Discord y pueden costarte la cuenta, así que aquí no se usan.)
2. **Puedes bloquear el móvil.** La cámara emite por sí sola a través de una Wi‑Fi de 5 GHz (por ejemplo, el punto de acceso del móvil). Una vez iniciado el directo, la app de Insta360 ya no hace falta. Para terminar, se detiene en la cámara.
3. **Comprueba esto primero** (30 segundos): en la app de Insta360, con la GO Ultra conectada, entra en *Directo* y mira si entre las plataformas aparece **RTMP** (dirección personalizada). La documentación de Insta360 no deja claro si la GO Ultra lo ofrece; si solo te deja YouTube, este puente no puede recibir la cámara directamente (mira «Si la app solo ofrece YouTube» más abajo). Necesitas firmware 1.2.16 o posterior y la app 2.14.0 o posterior.
4. **Hace falta un ordenador o servidor encendido** mientras emites, accesible desde Internet (la cámara estará en la calle con datos móviles).

## Puesta en marcha

Necesitas [Node.js 20 o posterior](https://nodejs.org). ffmpeg se instala solo con el proyecto.

```bash
cd insta360-discord
npm install
npm start
```

La consola muestra la dirección del panel (`http://localhost:8080/admin`) y, la primera vez, la **contraseña**. Todo lo demás se hace desde el panel.

Para probar sin la cámara: `npm run simular-camara` envía una carta de ajuste al puente.

### Con Docker (recomendado en un servidor)

```bash
DOMINIO=directo.midominio.com docker compose up -d
docker compose logs puente   # contraseña del panel
```

Incluye HTTPS automático (Caddy). El dominio debe apuntar al servidor y hay que abrir los puertos 80, 443 y 1935.

## Configuración, paso a paso (panel)

1. **Acceso desde Internet.** Escribe la dirección pública de la web (p. ej. `https://directo.midominio.com`).
   - *Servidor/VPS con IP pública*: es lo más sencillo; usa el `docker compose` de arriba.
   - *PC de casa*: abre en el router el puerto **1935 (TCP)** hacia el PC para la cámara, y publica la web (puerto 8080) con HTTPS mediante un túnel o un proxy inverso. Si tu operador usa CG‑NAT no podrás abrir puertos: usa un VPS.
2. **Discord · Avisos.** En Discord: *Editar canal → Integraciones → Webhooks → Nuevo webhook → Copiar URL*. Pégala en el panel y pulsa *Enviar mensaje de prueba*.
3. **Cámara.** Copia la *Dirección RTMP* del panel y pégala en la app de Insta360 (*Directo → RTMP*). Elige la Wi‑Fi de 5 GHz y empieza. En el móvil, el punto de acceso debe estar en 5 GHz (en iPhone, desactiva «Maximizar compatibilidad»).
4. **Discord · En el canal de voz (opcional).** Necesita HTTPS.
   1. En <https://discord.com/developers/applications> crea una aplicación. En *OAuth2* copia el **Client ID** y el **Client Secret**, y añade `https://127.0.0.1` en *Redirects*.
   2. En *Activities → URL Mappings*: prefijo `/`, destino el que muestra el panel (tu dominio, sin `https://`). Activa las actividades en *Activities → Settings*.
   3. Copia el **ID de tu servidor** (modo desarrollador → clic derecho en el servidor → *Copiar ID*) y guarda los tres datos en el panel.
   4. Instala la aplicación en tu servidor (*Installation*) y ábrela desde el canal de voz (icono de actividades).

## Privacidad y seguridad

- El visor solo se abre con un enlace que contiene un token aleatorio; puedes invalidarlo desde el panel. Quien tenga el enlace puede ver el directo.
- La Actividad comprueba con Discord que la persona pertenece a un servidor autorizado.
- La cámara solo puede emitir con la clave incluida en la dirección RTMP. No la compartas; se puede regenerar.
- RTMP no va cifrado: la clave viaja en claro entre la cámara y el servidor.
- Los secretos se guardan en `data/config.json`.

## Si la app solo ofrece YouTube

Emite a YouTube desde la app (también funciona con el móvil bloqueado) y comparte en Discord el enlace fijo de tu canal, `https://www.youtube.com/@TU_CANAL/live`: Discord lo reproduce incrustado y se puede ver en grupo con la actividad *Watch Together*. No necesitas este programa para eso.

## Variables de entorno (opcional)

Todo se puede fijar por variables en lugar del panel: `HTTP_PORT`, `RTMP_PORT`, `PUBLIC_URL`, `RTMP_PUBLIC_URL`, `STREAM_TITLE`, `STREAM_KEY`, `VIEW_TOKEN`, `ADMIN_PASSWORD`, `DISCORD_WEBHOOK_URL`, `DISCORD_MENTION`, `DISCORD_UPDATE_SECONDS`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_IDS`, `GRACE_SECONDS`, `TRUST_PROXY`, `DATA_DIR`, `FFMPEG_PATH`, `LOG_LEVEL`.

## Problemas frecuentes

| Síntoma | Qué mirar |
| --- | --- |
| El panel dice «se rechazó un intento de emisión» | La dirección RTMP de la app no coincide: vuelve a copiarla. |
| La cámara no conecta | ¿El puerto 1935 es accesible desde Internet? ¿La Wi‑Fi es de 5 GHz y tiene Internet? |
| El aviso de Discord no trae enlace | Falta la dirección pública en el panel. |
| La imagen se corta en el visor | Pulsa «Baja latencia» para pasar al modo «Compatible». |
| La Actividad se queda en blanco | La dirección pública debe ser HTTPS y coincidir con el *URL Mapping*. |

## Pruebas

`npm test` ejecuta las pruebas automáticas: protocolo RTMP, y un directo completo con una cámara simulada (ffmpeg) y un Discord simulado.

**Qué está comprobado y qué no.** Se ha probado con ffmpeg haciendo de cámara (H.264 + AAC por RTMP), reproducción real en Chromium en los dos modos, y la integración con Discord contra un servidor simulado que imita su API. **No se ha podido probar con una GO Ultra real ni dentro del Discord real**; el primer directo te dirá si hay que ajustar algo.
