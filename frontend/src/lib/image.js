/** Octets -> base64 (par blocs, pour ne pas dépasser la pile d'appels sur de gros fichiers). */
export async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Recadre une image au carré (centre) et la réduit à `side` px, puis la ré-encode en JPEG.
 * Le ré-encodage par le navigateur supprime au passage tout contenu caché dans le fichier d'origine (métadonnées, données ajoutées).
 */
export async function resizeToSquare(file, side = 256) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = side; canvas.height = side;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, side, side); // fond pour les PNG transparents
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, side, side);
  bmp.close?.();
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.86));
  if (!blob) throw new Error('encode');
  return toBase64(blob);
}

export const fmtSize = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
