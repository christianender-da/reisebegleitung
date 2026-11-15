/**
 * Foto/Avatar im Browser vorbereiten: quadratisch zuschneiden (bei Hochformat etwas nach oben versetzt, damit der Kopf
 * drin bleibt), auf 256 px verkleinern und neu als JPEG speichern. Durch das Neu-Speichern fallen Zusatzdaten wie
 * GPS-Position und Kameradaten (EXIF) weg. Ergebnis: data:-URL (typisch 15–40 KB).
 * Die Drehung aus den Kameradaten (Hochformat-Fotos vom iPhone) wendet der Browser beim Laden des Bildes an.
 */
export async function prepareAvatar(file: Blob, size = 256, quality = 0.85): Promise<string> {
  // Als data:-URL einlesen, nicht über URL.createObjectURL: blob:-Adressen blockiert eine strenge CSP
  // (img-src 'self' data:), wie sie die App und das Dashboard setzen.
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read'));
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const s = Math.min(w, h);
  if (!s) throw new Error('empty');
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#ffffff'; // JPEG kennt keine Transparenz
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (w - s) / 2, (h - s) * 0.3, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', quality);
}
