// Zero-dependency cross-platform bundle builder for MVRarchive.
// Syncs app version (1.0.YYMMDD) and creates mvrarchive.zip with index.html at root.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT_DIR = __dirname;
const OUT_FILE = path.join(ROOT_DIR, "mvrarchive.zip");

const BUNDLE_PATHS = [
  "index.html",
  "styles.css",
  "js",
  "assets"
];

function getVersionString() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `1.0.${yy}${mm}${dd}`;
}

function syncVersion() {
  const ver = getVersionString();

  // 1. Update package.json
  const pkgPath = path.join(ROOT_DIR, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.version = ver;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    } catch (e) { /* ignore */ }
  }

  // 2. Update index.html
  const htmlPath = path.join(ROOT_DIR, "index.html");
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, "utf8");
    html = html.replace(/(<span class="app-version[^>]*>)([^<]*)(<\/span>)/, `$1${ver}$3`);
    fs.writeFileSync(htmlPath, html);
  }

  console.log(`[build] Version: ${ver}`);
  return ver;
}

function collectFiles(baseRel, dir = "") {
  const full = path.join(ROOT_DIR, baseRel, dir);
  const stat = fs.statSync(full);
  if (!stat.isDirectory()) {
    return [{
      zipPath: path.join(baseRel, dir).replace(/\\/g, "/"),
      absPath: full,
      mtime: stat.mtime,
    }];
  }
  const entries = fs.readdirSync(full);
  const results = [];
  for (const entry of entries) {
    const sub = dir ? path.join(dir, entry) : entry;
    results.push(...collectFiles(baseRel, sub));
  }
  return results;
}

function dosDateTime(date) {
  const d = new Date(date);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: dt };
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ~crc >>> 0;
}

function buildZip() {
  syncVersion();

  const fileEntries = [];
  for (const p of BUNDLE_PATHS) {
    if (fs.existsSync(path.join(ROOT_DIR, p))) {
      fileEntries.push(...collectFiles(p));
    }
  }

  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of fileEntries) {
    const content = fs.readFileSync(file.absPath);
    const deflated = zlib.deflateRawSync(content);
    const useDeflate = deflated.length < content.length;
    const data = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0; // 8 = Deflate, 0 = Store
    const fileCrc = crc32(content);
    const { time, date } = dosDateTime(file.mtime);
    const nameBuf = Buffer.from(file.zipPath, "utf8");

    // Local file header (30 bytes + name)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);  // signature
    lh.writeUInt16LE(20, 4);          // version needed (2.0)
    lh.writeUInt16LE(0x0800, 6);       // general purpose bit flag (UTF-8)
    lh.writeUInt16LE(method, 8);      // compression method
    lh.writeUInt16LE(time, 10);       // last mod time
    lh.writeUInt16LE(date, 12);       // last mod date
    lh.writeUInt32LE(fileCrc, 14);     // crc-32
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(content.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // filename length
    lh.writeUInt16LE(0, 28);          // extra field length
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, data);

    // Central directory header (46 bytes + name)
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);  // signature
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);       // general purpose bit flag (UTF-8)
    ch.writeUInt16LE(method, 10);     // compression method
    ch.writeUInt16LE(time, 12);       // last mod time
    ch.writeUInt16LE(date, 14);       // last mod date
    ch.writeUInt32LE(fileCrc, 16);     // crc-32
    ch.writeUInt32LE(data.length, 20); // compressed size
    ch.writeUInt32LE(content.length, 24); // uncompressed size
    ch.writeUInt16LE(nameBuf.length, 28); // filename length
    ch.writeUInt16LE(0, 30);          // extra field length
    ch.writeUInt16LE(0, 32);          // file comment length
    ch.writeUInt16LE(0, 34);          // disk number start
    ch.writeUInt16LE(0, 36);          // internal file attributes
    ch.writeUInt32LE(0, 38);          // external file attributes
    ch.writeUInt32LE(offset, 42);     // relative offset of local header
    nameBuf.copy(ch, 46);

    centralHeaders.push(ch);
    offset += lh.length + data.length;
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralHeaders);
  const cdLength = cdBuf.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // signature
  eocd.writeUInt16LE(0, 4);           // disk number
  eocd.writeUInt16LE(0, 6);           // disk with central directory
  eocd.writeUInt16LE(fileEntries.length, 8);  // total entries on disk
  eocd.writeUInt16LE(fileEntries.length, 10); // total entries
  eocd.writeUInt32LE(cdLength, 12);   // size of central directory
  eocd.writeUInt32LE(cdOffset, 16);   // offset of start of central directory
  eocd.writeUInt16LE(0, 20);          // zip comment length

  const fullZip = Buffer.concat([...localHeaders, cdBuf, eocd]);
  fs.writeFileSync(OUT_FILE, fullZip);

  console.log(`[build] Created ${OUT_FILE} (${fullZip.length} bytes, ${fileEntries.length} files)`);
}

buildZip();
