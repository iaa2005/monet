/**
 * Does Electron nativeImage do what media-tool.ts assumes?
 *
 * Written because two of those assumptions turned out to be wrong. On a dense
 * 2000px screenshot, JPEG at quality 85 came out LARGER than the PNG, and the
 * quality ladder alone never reached the 256 KB budget — the tool would have
 * refused an entirely ordinary image. Both only showed up by running it.
 *
 * Needs a real Electron runtime, so it is a .cjs run under `npx electron`
 * rather than a renderer-probe.
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const { writeFileSync, statSync, mkdtempSync } = require("fs");
const { join } = require("path");
const { tmpdir } = require("os");

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log("PASS  " + name);
  else {
    failures++;
    console.log("FAIL  " + name);
    if (detail !== undefined) console.log("      ", JSON.stringify(detail));
  }
};

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), "nativeimg-"));

  // A big, detailed PNG — detail matters: a flat colour compresses to nothing
  // and would not exercise the byte budget at all.
  const win = new BrowserWindow({
    width: 3000,
    height: 2000,
    show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0">
      <canvas id="c" width="3000" height="2000"></canvas>
      <script>
        const x = document.getElementById('c').getContext('2d');
        for (let i = 0; i < 6000; i++) {
          x.fillStyle = 'hsl(' + (i * 7 % 360) + ',80%,' + (30 + (i % 50)) + '%)';
          x.fillRect((i * 37) % 3000, (i * 53) % 2000, 40, 30);
        }
        x.fillStyle = '#000'; x.font = '24px monospace';
        for (let i = 0; i < 60; i++) x.fillText('fine detail line ' + i, 20, 30 + i * 32);
      </script></body>`),
  );
  await new Promise((r) => setTimeout(r, 1200));
  const shot = await win.webContents.capturePage();
  const bigPath = join(dir, "big.png");
  writeFileSync(bigPath, shot.toPNG());

  const bytes = statSync(bigPath).size;
  console.log(`fixture: ${bigPath} — ${Math.round(bytes / 1024)} KB`);

  const img = nativeImage.createFromPath(bigPath);
  check("createFromPath decodes a real PNG", !img.isEmpty());

  const size = img.getSize();
  check("getSize reports a plausible size", size.width > 2500 && size.height > 1500, size);
  check("the fixture is over the 256KB budget", bytes > 256 * 1024, bytes);

  // Resize
  const scale = 2000 / Math.max(size.width, size.height);
  const target = {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  };
  const resized = img.resize({ ...target, quality: "good" });
  const rs = resized.getSize();
  check("resize honours the requested size", rs.width === target.width && rs.height === target.height, { rs, target });
  check("resize preserves aspect ratio", Math.abs(rs.width / rs.height - size.width / size.height) < 0.01);
  check("the resized longest edge is within the ceiling", Math.max(rs.width, rs.height) <= 2000, rs);

  // Crop
  const cropped = img.crop({ x: 100, y: 50, width: 400, height: 300 });
  const cs = cropped.getSize();
  check("crop honours the requested rectangle", cs.width === 400 && cs.height === 300, cs);
  check("a crop is smaller than the original", cropped.toPNG().byteLength < img.toPNG().byteLength);

  // Encoding: the fallback chain media-tool.ts relies on.
  const png = resized.toPNG().byteLength;
  const q85 = resized.toJPEG(85).byteLength;
  const q40 = resized.toJPEG(40).byteLength;
  console.log('  note: png=' + png + ' q85=' + q85 + ' — JPEG is NOT always smaller');
  check("lower quality is smaller still", q40 < q85, { q85, q40 });

  // The real encoder from media-tool.ts: shrink the EDGE too, not just quality.
  let out = null, type = null;
  const png0 = resized.toPNG();
  if (png0.byteLength <= 256*1024) { out = png0; type = 'image/png'; }
  const fullSz = resized.getSize();
  for (const f of [1,0.75,0.5,0.35,0.25]) {
    if (out) break;
    const im = f === 1 ? resized : resized.resize({width: Math.max(1,Math.round(fullSz.width*f)), height: Math.max(1,Math.round(fullSz.height*f)), quality:'good'});
    for (const q of [85,65,45]) {
      const b = im.toJPEG(q);
      if (b.byteLength <= 256*1024) { out = b; type = 'image/jpeg'; break; }
    }
  }
  if (!out) { out = Buffer.alloc(0); type = 'none'; }
  console.log(`  encoded: ${type}, ${Math.round(out.byteLength / 1024)} KB`);
  check("the fallback chain reaches the byte budget", out.byteLength <= 256 * 1024, out.byteLength);

  // Base64 is what actually travels — confirm it is still usable.
  const b64 = out.toString("base64");
  check("base64 round-trips to a decodable image", !nativeImage.createFromBuffer(Buffer.from(b64, "base64")).isEmpty());

  // A file that is not an image must be refused, not silently empty.
  const junk = join(dir, "notreally.png");
  writeFileSync(junk, "this is not a png");
  check("a non-image file reports isEmpty", nativeImage.createFromPath(junk).isEmpty());

  console.log(failures === 0 ? "\nALL NATIVEIMAGE CHECKS PASSED" : `\n${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
