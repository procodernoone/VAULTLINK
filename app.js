(function () {
  'use strict';

  const CHUNK_SIZE = 16384;
  const READ_SIZE = 262144;
  const BUFFER_HIGH = 1048576;
  const BUFFER_LOW = 262144;
  const ICE_GATHER_TIMEOUT = 7000;
  const ICE_IDLE_WAIT = 2500;
  const CODE_PREFIX = 'VL2.';
  const MAX_CANDIDATES = 12;
  const KIND_NAMES = ['host', 'srflx', 'relay', 'prflx'];
  const KIND_PREF = [126, 100, 0, 110];
  const SETUP_NAMES = ['actpass', 'active', 'passive'];
  const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
  const DAMAGED = 'The code is damaged or incomplete. Copy it again in full.';
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };

  const QR_ECC_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
  const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
  const QR_MAX_VERSION = 20;
  const QR_FINDER_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].map(Boolean);
  const QR_FINDER_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].map(Boolean);

  const STATUS_TEXT = {
    new: 'Waiting for peer',
    connecting: 'Connecting',
    connected: 'Connected',
    disconnected: 'Disconnected',
    failed: 'Connection failed',
    closed: 'Closed'
  };
  const STATUS_KIND = {
    new: 'busy',
    connecting: 'busy',
    connected: 'ok',
    disconnected: 'bad',
    failed: 'bad',
    closed: 'bad'
  };
  const ICE_TO_CONN = {
    new: 'new',
    checking: 'connecting',
    connected: 'connected',
    completed: 'connected',
    disconnected: 'disconnected',
    failed: 'failed',
    closed: 'closed'
  };

  const ICON_X = '<svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"/></svg>';

  const $ = (id) => document.getElementById(id);

  const dot = $('status-dot');
  const statusText = $('status-text');
  const warning = $('protocol-warning');
  const warningText = $('warning-text');
  const connectBody = $('connect-body');
  const connectedBox = $('connected-box');
  const connectMsg = $('connect-msg');
  const tabHost = $('tab-host');
  const tabJoin = $('tab-join');
  const paneHost = $('pane-host');
  const paneJoin = $('pane-join');
  const btnCreate = $('btn-create');
  const btnFinish = $('btn-finish');
  const btnReply = $('btn-reply');
  const btnScanReply = $('btn-scan-reply');
  const btnScanInvite = $('btn-scan-invite');
  const btnDisconnect = $('btn-disconnect');
  const btnCopyInvite = $('btn-copy-invite');
  const btnCopyReply = $('btn-copy-reply');
  const inviteOut = $('invite-out');
  const inviteQrWrap = $('invite-qr-wrap');
  const inviteQr = $('invite-qr');
  const replyIn = $('reply-in');
  const inviteIn = $('invite-in');
  const replyOut = $('reply-out');
  const replyQrWrap = $('reply-qr-wrap');
  const replyQr = $('reply-qr');
  const scanner = $('scanner');
  const scannerVideo = $('scanner-video');
  const scannerOverlay = $('scanner-overlay');
  const scannerStatus = $('scanner-status');
  const scannerClose = $('scanner-close');
  const scannerPhotoBtn = $('scanner-photo-btn');
  const scannerPhoto = $('scanner-photo');
  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const queueList = $('queue');
  const btnSend = $('btn-send');
  const btnClear = $('btn-clear');
  const sendHint = $('send-hint');
  const recvEmpty = $('recv-empty');
  const recvList = $('received');
  const creditBtn = $('credit-btn');
  const creditMenu = $('credit-menu');
  const logo = $('logo');

  let pc = null;
  let dc = null;
  let queue = [];
  let incoming = null;
  let sending = false;
  let uid = 0;
  let objectUrls = [];
  let scanSession = null;
  let jsQrPromise = null;

  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function bytesToHex(bytes) {
    return bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  }

  function parseIPv4(str) {
    const parts = str.split('.');
    if (parts.length !== 4) return null;
    const out = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = parseInt(p, 10);
      if (n > 255) return null;
      out.push(n);
    }
    return out;
  }

  function parseIPv6(str) {
    const clean = str.split('%')[0];
    if (clean.indexOf('.') !== -1) return null;
    const halves = clean.split('::');
    if (halves.length > 2) return null;
    const toGroups = (s) => (s === '' ? [] : s.split(':'));
    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];
    let groups;
    if (halves.length === 2) {
      const fill = 8 - head.length - tail.length;
      if (fill < 1) return null;
      groups = head.concat(new Array(fill).fill('0'), tail);
    } else {
      groups = head;
    }
    if (groups.length !== 8) return null;
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      const n = parseInt(g, 16);
      out.push(n >> 8, n & 255);
    }
    return out;
  }

  function formatIPv6(bytes) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return groups.join(':');
  }

  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i += 1) {
        crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
      }
    }
    return crc;
  }

  function toBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const out = [];
    for (let i = 0; i < bin.length; i += 1) out.push(bin.charCodeAt(i));
    return out;
  }

  function pushString(out, str) {
    if (str.length > 255) throw new Error('Unsupported connection details.');
    out.push(str.length);
    for (let i = 0; i < str.length; i += 1) out.push(str.charCodeAt(i) & 127);
  }

  function sdpValue(lines, prefix) {
    for (const line of lines) {
      if (line.indexOf(prefix) === 0) return line.slice(prefix.length).trim();
    }
    return null;
  }

  function encodeDescription(desc) {
    const lines = desc.sdp.split(/\r?\n/);
    const ufrag = sdpValue(lines, 'a=ice-ufrag:');
    const pwd = sdpValue(lines, 'a=ice-pwd:');
    const fp = sdpValue(lines, 'a=fingerprint:');
    const setup = sdpValue(lines, 'a=setup:');
    const mid = sdpValue(lines, 'a=mid:') || '0';
    if (!ufrag || !pwd || !fp || !setup) throw new Error('Could not read the connection details. Try again.');
    const fpParts = fp.split(/\s+/);
    const fpBytes = fpParts.length === 2 ? hexToBytes(fpParts[1].replace(/:/g, '')) : [];
    if (fpParts[0].toLowerCase() !== 'sha-256' || fpBytes.length !== 32) {
      throw new Error('This browser uses an unsupported certificate fingerprint.');
    }
    const setupIdx = SETUP_NAMES.indexOf(setup);
    if (setupIdx < 0) throw new Error('Unsupported connection details.');

    const out = [(desc.type === 'answer' ? 1 : 0) | (setupIdx << 1)];
    fpBytes.forEach((b) => out.push(b));
    pushString(out, ufrag);
    pushString(out, pwd);
    pushString(out, mid);

    const seen = {};
    const cands = [];
    for (const line of lines) {
      if (line.indexOf('a=candidate:') !== 0 || cands.length >= MAX_CANDIDATES) continue;
      const p = line.slice(12).trim().split(/\s+/);
      if (p.length < 8 || p[2].toLowerCase() !== 'udp' || p[6] !== 'typ') continue;
      const kind = KIND_NAMES.indexOf(p[7]);
      const port = parseInt(p[5], 10);
      if (kind < 0 || !(port > 0 && port < 65536)) continue;
      let flags = kind;
      let addr = null;
      const v4 = parseIPv4(p[4]);
      if (v4) {
        if (v4[0] === 169 && v4[1] === 254) continue;
        addr = v4;
      } else {
        const m = UUID_RE.exec(p[4]);
        if (m) {
          flags |= 8;
          addr = hexToBytes(m.slice(1).join(''));
        } else {
          const v6 = parseIPv6(p[4]);
          if (!v6 || (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80)) continue;
          flags |= 4;
          addr = v6;
        }
      }
      const key = flags + ':' + addr.join('.') + ':' + port;
      if (seen[key]) continue;
      seen[key] = true;
      cands.push({ flags, port, addr });
    }
    if (!cands.length) throw new Error('No network candidates were found. Check your connection and try again.');

    out.push(cands.length);
    cands.forEach((c) => {
      out.push(c.flags, c.port >> 8, c.port & 255);
      c.addr.forEach((b) => out.push(b));
    });
    const sum = crc16(out);
    out.push(sum >> 8, sum & 255);
    return CODE_PREFIX + toBase64Url(out);
  }

  function decodeDescription(raw, expected) {
    const code = String(raw || '').replace(/\s+/g, '');
    if (!code) throw new Error('Paste a code first.');
    if (code.indexOf(CODE_PREFIX) !== 0) {
      throw new Error('That is not a Vaultlink code. Codes from older versions will not work.');
    }
    let type;
    let sdp;
    try {
      const bytes = fromBase64Url(code.slice(CODE_PREFIX.length));
      if (bytes.length < 44) throw new Error(DAMAGED);
      const body = bytes.slice(0, -2);
      if (crc16(body) !== ((bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1])) throw new Error(DAMAGED);
      let pos = 0;
      const next = () => {
        if (pos >= body.length) throw new Error(DAMAGED);
        pos += 1;
        return body[pos - 1];
      };
      const take = (n) => {
        const chunk = [];
        for (let i = 0; i < n; i += 1) chunk.push(next());
        return chunk;
      };
      const readString = () => String.fromCharCode.apply(null, take(next()));

      const head = next();
      type = (head & 1) ? 'answer' : 'offer';
      const setupIdx = (head >> 1) & 3;
      if (setupIdx > 2) throw new Error(DAMAGED);
      const fpHex = bytesToHex(take(32)).toUpperCase().match(/../g).join(':');
      const ufrag = readString();
      const pwd = readString();
      const mid = readString();
      const count = next();
      const candLines = [];
      for (let i = 0; i < count; i += 1) {
        const flags = next();
        const port = (next() << 8) | next();
        const kind = flags & 3;
        let host;
        if (flags & 8) {
          const h = bytesToHex(take(16));
          host = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-') + '.local';
        } else if (flags & 4) {
          host = formatIPv6(take(16));
        } else {
          host = take(4).join('.');
        }
        const priority = KIND_PREF[kind] * 16777216 + (65535 - i) * 256 + 255;
        let line = 'a=candidate:' + (i + 1) + ' 1 udp ' + priority + ' ' + host + ' ' + port + ' typ ' + KIND_NAMES[kind];
        if (kind === 1 || kind === 2) line += ' raddr 0.0.0.0 rport 0';
        candLines.push(line);
      }
      if (pos !== body.length || !count) throw new Error(DAMAGED);

      sdp = [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE ' + mid,
        'a=msid-semantic: WMS',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 0.0.0.0',
        'a=ice-ufrag:' + ufrag,
        'a=ice-pwd:' + pwd,
        'a=fingerprint:sha-256 ' + fpHex,
        'a=setup:' + SETUP_NAMES[setupIdx],
        'a=mid:' + mid,
        'a=sctp-port:5000',
        'a=max-message-size:262144'
      ].concat(candLines, ['a=end-of-candidates']).join('\r\n') + '\r\n';
    } catch (e) {
      throw new Error(DAMAGED);
    }
    if (type !== expected) {
      throw new Error(expected === 'offer'
        ? 'This is a reply code. Paste the invite code here.'
        : 'This is an invite code. Paste the reply code here.');
    }
    return { type, sdp };
  }

  function qrRawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }

  function qrDataCodewords(ver) {
    return Math.floor(qrRawModules(ver) / 8) - QR_ECC_BLOCK[ver] * QR_BLOCKS[ver];
  }

  function qrAlignPositions(ver) {
    if (ver === 1) return [];
    const count = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
    const out = [6];
    for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < degree; j += 1) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
  }

  function qrInterleave(data, ver) {
    const numBlocks = QR_BLOCKS[ver];
    const eccLen = QR_ECC_BLOCK[ver];
    const rawWords = Math.floor(qrRawModules(ver) / 8);
    const numShort = numBlocks - (rawWords % numBlocks);
    const shortLen = Math.floor(rawWords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i += 1) {
      const len = shortLen - eccLen + (i < numShort ? 0 : 1);
      const dat = data.slice(k, k + len);
      k += len;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i += 1) {
      blocks.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= numShort) out.push(block[i]);
      });
    }
    return out;
  }

  function qrMaskBit(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    }
  }

  function qrBuildMatrix(ver, codewords) {
    const size = ver * 4 + 17;
    const modules = [];
    const fn = [];
    for (let y = 0; y < size; y += 1) {
      modules.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    const setFn = (x, y, dark) => {
      modules[y][x] = dark;
      fn[y][x] = true;
    };
    const bit = (v, i) => ((v >>> i) & 1) !== 0;

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(x, y, d !== 2 && d !== 4);
          }
        }
      }
    };

    const align = (cx, cy) => {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    };

    const drawFormat = (mask) => {
      let rem = mask;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((mask << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i += 1) setFn(8, i, bit(bits, i));
      setFn(8, 7, bit(bits, 6));
      setFn(8, 8, bit(bits, 7));
      setFn(7, 8, bit(bits, 8));
      for (let i = 9; i < 15; i += 1) setFn(14 - i, 8, bit(bits, i));
      for (let i = 0; i < 8; i += 1) setFn(size - 1 - i, 8, bit(bits, i));
      for (let i = 8; i < 15; i += 1) setFn(8, size - 15 + i, bit(bits, i));
      setFn(8, size - 8, true);
    };

    const drawVersion = () => {
      if (ver < 7) return;
      let rem = ver;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const color = bit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFn(a, b, color);
        setFn(b, a, color);
      }
    };

    for (let i = 0; i < size; i += 1) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    const pos = qrAlignPositions(ver);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
        if (!corner) align(pos[i], pos[j]);
      }
    }
    drawFormat(0);
    drawVersion();

    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && bitIndex < codewords.length * 8) {
            modules[y][x] = bit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex += 1;
          }
        }
      }
    }

    const applyMask = (m) => {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (!fn[y][x] && qrMaskBit(m, x, y)) modules[y][x] = !modules[y][x];
        }
      }
    };

    const scanLine = (line) => {
      let score = 0;
      let run = 1;
      for (let i = 1; i < size; i += 1) {
        if (line[i] === line[i - 1]) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
      for (let i = 0; i + 11 <= size; i += 1) {
        let a = true;
        let b = true;
        for (let k = 0; k < 11; k += 1) {
          if (line[i + k] !== QR_FINDER_A[k]) a = false;
          if (line[i + k] !== QR_FINDER_B[k]) b = false;
        }
        if (a || b) score += 40;
      }
      return score;
    };

    const penalty = () => {
      let total = 0;
      let dark = 0;
      for (let y = 0; y < size; y += 1) {
        total += scanLine(modules[y]);
        const col = [];
        for (let x = 0; x < size; x += 1) {
          col.push(modules[x][y]);
          if (modules[y][x]) dark += 1;
        }
        total += scanLine(col);
      }
      for (let y = 0; y < size - 1; y += 1) {
        for (let x = 0; x < size - 1; x += 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) total += 3;
        }
      }
      const cells = size * size;
      const k = Math.ceil(Math.abs(dark * 20 - cells * 10) / cells) - 1;
      return total + Math.max(0, k) * 10;
    };

    let bestMask = 0;
    let best = Infinity;
    for (let m = 0; m < 8; m += 1) {
      applyMask(m);
      drawFormat(m);
      const p = penalty();
      if (p < best) {
        best = p;
        bestMask = m;
      }
      applyMask(m);
    }
    applyMask(bestMask);
    drawFormat(bestMask);
    return modules;
  }

  function qrEncode(text) {
    const data = [];
    for (let i = 0; i < text.length; i += 1) data.push(text.charCodeAt(i) & 255);
    let ver = 1;
    while (ver <= QR_MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + data.length * 8 > qrDataCodewords(ver) * 8) ver += 1;
    if (ver > QR_MAX_VERSION) throw new Error('This code is too long for a QR code.');
    const bits = [];
    const put = (val, len) => {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    };
    put(4, 4);
    put(data.length, ver < 10 ? 8 : 16);
    data.forEach((b) => put(b, 8));
    const capacity = qrDataCodewords(ver) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j];
      words.push(v);
    }
    for (let pad = 0xec; words.length < qrDataCodewords(ver); pad ^= 0xec ^ 0x11) words.push(pad);
    return qrBuildMatrix(ver, qrInterleave(words, ver));
  }

  function drawQr(canvas, text) {
    const matrix = qrEncode(text);
    const n = matrix.length;
    const quiet = 4;
    const scale = Math.max(3, Math.floor(520 / (n + quiet * 2)));
    const px = (n + quiet * 2) * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        if (matrix[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }

  function setStatus(kind, text) {
    dot.dataset.state = kind;
    statusText.textContent = text;
  }

  function showMsg(text, kind) {
    connectMsg.textContent = text;
    connectMsg.dataset.kind = kind || 'info';
    connectMsg.hidden = false;
  }

  function clearMsg() {
    connectMsg.textContent = '';
    connectMsg.hidden = true;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  function safeName(name) {
    const cleaned = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return cleaned || 'received-file';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isWebView() {
    const ua = navigator.userAgent || '';
    if (/; wv\)/.test(ua)) return true;
    if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat/.test(ua)) return true;
    return /(iPhone|iPad|iPod)/.test(ua) && !/Safari\//.test(ua);
  }

  function checkEnvironment() {
    const lines = [];
    if (location.protocol === 'file:') {
      lines.push('This page was opened from a file:// address. WebRTC needs http://localhost or https://. Serve this folder, for example with "python3 -m http.server 8000", then open http://localhost:8000.');
    } else if (window.isSecureContext === false) {
      lines.push('This page is not in a secure context. WebRTC, camera and clipboard access need http://localhost or https://.');
    }
    if (!window.RTCPeerConnection) {
      lines.push('This browser does not support WebRTC.');
      [btnCreate, btnFinish, btnReply].forEach((b) => { b.disabled = true; });
    }
    if (lines.length) {
      warningText.textContent = lines.join(' ');
      warning.hidden = false;
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  function normalizeState(peer) {
    if (peer.connectionState) return peer.connectionState;
    return ICE_TO_CONN[peer.iceConnectionState] || 'new';
  }

  function renderPeerState(peer) {
    if (peer !== pc) return;
    const s = normalizeState(peer);
    setStatus(STATUS_KIND[s] || 'busy', STATUS_TEXT[s] || s);
    if (s === 'failed') {
      showMsg('The connection failed. Direct paths between these networks may be blocked; a TURN relay could be required.', 'error');
    }
  }

  function teardown() {
    const oldDc = dc;
    const oldPc = pc;
    dc = null;
    pc = null;
    if (oldDc) {
      try { oldDc.close(); } catch (e) { void e; }
    }
    if (oldPc) {
      try { oldPc.close(); } catch (e) { void e; }
    }
  }

  function createPeer() {
    teardown();
    const peer = new RTCPeerConnection(RTC_CONFIG);
    pc = peer;
    peer.addEventListener('connectionstatechange', () => renderPeerState(peer));
    peer.addEventListener('iceconnectionstatechange', () => renderPeerState(peer));
    renderPeerState(peer);
    return peer;
  }

  function waitForGathering(peer) {
    return new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      let idle = null;
      let cap = null;
      const finish = () => {
        clearTimeout(idle);
        clearTimeout(cap);
        peer.removeEventListener('icecandidate', onCandidate);
        peer.removeEventListener('icegatheringstatechange', onState);
        resolve();
      };
      const onCandidate = (e) => {
        if (!e.candidate) {
          finish();
          return;
        }
        clearTimeout(idle);
        idle = setTimeout(finish, ICE_IDLE_WAIT);
      };
      const onState = () => {
        if (peer.iceGatheringState === 'complete') finish();
      };
      idle = setTimeout(finish, ICE_IDLE_WAIT);
      cap = setTimeout(finish, ICE_GATHER_TIMEOUT);
      peer.addEventListener('icecandidate', onCandidate);
      peer.addEventListener('icegatheringstatechange', onState);
    });
  }

  async function run(btn, busyLabel, task) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    clearMsg();
    try {
      await task();
    } catch (err) {
      showMsg(err && err.message ? err.message : String(err), 'error');
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  async function copyField(field, btn) {
    const text = field.value;
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      field.focus();
      field.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    }
    const label = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    setTimeout(() => { btn.textContent = label; }, 1600);
  }

  function setOutput(field, btn, value, qrWrap, qrCanvas) {
    field.value = value;
    btn.disabled = !value;
    qrWrap.hidden = !value;
    if (!value) return;
    try {
      drawQr(qrCanvas, value);
    } catch (e) {
      qrWrap.hidden = true;
    }
  }

  function setInvite(value) {
    setOutput(inviteOut, btnCopyInvite, value, inviteQrWrap, inviteQr);
  }

  function setReply(value) {
    setOutput(replyOut, btnCopyReply, value, replyQrWrap, replyQr);
  }

  function resetSignaling() {
    setInvite('');
    setReply('');
    replyIn.value = '';
    inviteIn.value = '';
  }

  function setConnected(on) {
    if (on) closeScanner();
    connectBody.hidden = on;
    connectedBox.hidden = !on;
    updateSendControls();
  }

  function channelOpen() {
    return !!dc && dc.readyState === 'open';
  }

  function updateSendControls() {
    const open = channelOpen();
    const pending = queue.some((i) => i.state === 'queued');
    btnSend.disabled = !(open && pending) || sending;
    btnClear.hidden = queue.length === 0;
    queueList.hidden = queue.length === 0;
    if (!open) sendHint.textContent = 'Connect to a peer to enable sending.';
    else if (!queue.length) sendHint.textContent = 'Add files to send.';
    else if (sending) sendHint.textContent = 'Sending...';
    else sendHint.textContent = '';
  }

  function bindChannel(ch) {
    dc = ch;
    ch.binaryType = 'arraybuffer';
    ch.bufferedAmountLowThreshold = BUFFER_LOW;
    ch.addEventListener('open', () => {
      if (dc !== ch) return;
      clearMsg();
      setConnected(true);
    });
    ch.addEventListener('close', () => {
      if (dc !== ch) return;
      handleRemoteClose();
    });
    ch.addEventListener('error', () => {
      if (dc !== ch) return;
      showMsg('Data channel error.', 'error');
    });
    ch.addEventListener('message', (ev) => {
      if (dc !== ch) return;
      handleMessage(ev.data);
    });
    if (ch.readyState === 'open') setConnected(true);
  }

  function handleRemoteClose() {
    failReceive('Connection lost');
    teardown();
    setConnected(false);
    resetSignaling();
    setStatus('bad', 'Disconnected');
    showMsg('The channel closed. Start a new connection to continue.', 'error');
  }

  async function createInvite() {
    const peer = createPeer();
    bindChannel(peer.createDataChannel('vaultlink', { ordered: true }));
    setInvite('');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForGathering(peer);
    if (peer !== pc) return;
    setInvite(encodeDescription(peer.localDescription));
    showMsg('Invite ready. Let the other device scan the QR code, or copy the code and send it.', 'ok');
  }

  async function finishConnection() {
    const remote = decodeDescription(replyIn.value, 'answer');
    if (!pc || pc.signalingState !== 'have-local-offer') {
      throw new Error('Create an invite first, then paste the reply to that invite.');
    }
    await pc.setRemoteDescription(remote);
    showMsg('Reply accepted. Connecting...', 'ok');
  }

  async function generateReply() {
    const remote = decodeDescription(inviteIn.value, 'offer');
    const peer = createPeer();
    peer.addEventListener('datachannel', (e) => bindChannel(e.channel));
    setReply('');
    await peer.setRemoteDescription(remote);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForGathering(peer);
    if (peer !== pc) return;
    setReply(encodeDescription(peer.localDescription));
    showMsg('Reply ready. Let the other device scan this QR code, or copy the code and send it back.', 'ok');
  }

  function disconnect() {
    failReceive('Disconnected');
    teardown();
    setConnected(false);
    resetSignaling();
    clearMsg();
    setStatus('idle', 'Not connected');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the QR scanner library (jsQR.js).'));
      document.head.appendChild(s);
    });
  }

  function ensureJsQr() {
    if (window.jsQR) return Promise.resolve();
    if (!jsQrPromise) {
      jsQrPromise = loadScript('jsQR.js').catch((err) => {
        jsQrPromise = null;
        throw err;
      });
    }
    return jsQrPromise;
  }

  async function requestCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Live camera needs https:// or http://localhost. Use "Scan from photo" below instead.');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw err;
    }
  }

  async function describeCameraError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      let state = '';
      try {
        state = (await navigator.permissions.query({ name: 'camera' })).state;
      } catch (e) {
        state = '';
      }
      if (state === 'denied') {
        return 'Camera is blocked for this site. Open your browser\'s site settings, set Camera to Allow, then reload the page. You can also use "Scan from photo" below.';
      }
      if (isWebView()) {
        return 'This app\'s built-in browser does not allow camera access. Open Vaultlink in Chrome or Safari, or use "Scan from photo" below.';
      }
      return 'Camera access was not granted. Allow it when your browser asks, or use "Scan from photo" below.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No camera was found on this device. Use "Scan from photo" below instead.';
    }
    if (name === 'NotReadableError') {
      return 'The camera is being used by another app. Close it and try again.';
    }
    return err && err.message ? err.message : 'Could not start the camera.';
  }

  function showScannerOverlay(text, isError) {
    scannerOverlay.textContent = text;
    scannerOverlay.dataset.kind = isError ? 'error' : '';
    scannerOverlay.hidden = false;
  }

  function setScanStatus(text, kind) {
    scannerStatus.textContent = text;
    scannerStatus.dataset.kind = kind || '';
  }

  function stopCamera(session) {
    session.stopped = true;
    clearTimeout(session.timer);
    if (session.stream) {
      session.stream.getTracks().forEach((t) => t.stop());
      session.stream = null;
    }
    scannerVideo.srcObject = null;
  }

  function closeScanner() {
    if (!scanSession) return;
    const session = scanSession;
    scanSession = null;
    stopCamera(session);
    scanner.hidden = true;
  }

  async function startScan(onCode) {
    clearMsg();
    closeScanner();
    const session = { onCode, stream: null, stopped: false, timer: null };
    scanSession = session;
    scanner.hidden = false;
    setScanStatus('', '');
    showScannerOverlay('Starting camera. Allow camera access if your browser asks.', false);

    const lib = ensureJsQr();
    lib.catch(() => {});
    let stream = null;
    try {
      stream = await requestCamera();
      await lib;
    } catch (err) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (scanSession !== session) return;
      showScannerOverlay(await describeCameraError(err), true);
      return;
    }
    if (scanSession !== session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    session.stream = stream;
    scannerVideo.srcObject = stream;
    try {
      await scannerVideo.play();
    } catch (e) {
      void e;
    }
    if (scanSession !== session) return;
    scannerOverlay.hidden = true;
    setScanStatus('Point the camera at the QR code.', '');

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (session.stopped) return;
      const vw = scannerVideo.videoWidth;
      const vh = scannerVideo.videoHeight;
      if (scannerVideo.readyState >= 2 && vw) {
        const scale = Math.min(1, 800 / vw);
        canvas.width = Math.round(vw * scale);
        canvas.height = Math.round(vh * scale);
        ctx.drawImage(scannerVideo, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = window.jsQR(img.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
        if (hit && hit.data.indexOf(CODE_PREFIX) === 0) {
          closeScanner();
          onCode(hit.data);
          return;
        }
        if (hit) setScanStatus('That QR code is not a Vaultlink code.', 'error');
      }
      session.timer = setTimeout(tick, 120);
    };
    tick();
  }

  async function decodePhoto(file) {
    await ensureJsQr();
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not read that image.'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      for (const maxSide of [1600, 1000, 640]) {
        const scale = Math.min(1, maxSide / longest);
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = window.jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
        if (hit && hit.data.indexOf(CODE_PREFIX) === 0) return hit.data;
      }
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildBar() {
    const bar = el('div', 'bar');
    const fill = document.createElement('span');
    bar.appendChild(fill);
    return { bar, fill };
  }

  function addFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      const item = { file, state: 'queued', ui: null };
      const li = el('li', 'row');
      li.dataset.state = 'queued';
      const name = el('span', 'row-name', file.name);
      name.title = file.name;
      const meta = el('span', 'row-meta', formatBytes(file.size));
      const state = el('span', 'row-state', 'Queued');
      const action = el('span', 'row-action');
      const rm = el('button', 'icon-btn');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove ' + file.name);
      rm.innerHTML = ICON_X;
      action.appendChild(rm);
      const parts = buildBar();
      li.append(name, meta, state, action, parts.bar);
      item.ui = { li, state, fill: parts.fill, rm };
      rm.addEventListener('click', () => {
        if (item.state === 'sending') return;
        queue = queue.filter((q) => q !== item);
        li.remove();
        updateSendControls();
      });
      queue.push(item);
      queueList.appendChild(li);
    });
    updateSendControls();
  }

  function setItemState(item, state, text) {
    item.state = state;
    item.ui.li.dataset.state = state;
    item.ui.state.textContent = text;
    item.ui.rm.hidden = state !== 'queued';
  }

  function setProgress(item, ratio) {
    const pct = Math.max(0, Math.min(1, ratio)) * 100;
    item.ui.fill.style.width = pct + '%';
    if (item.state === 'sending') item.ui.state.textContent = 'Sending ' + Math.floor(pct) + '%';
  }

  function waitForBuffer(ch) {
    if (ch.readyState !== 'open') {
      return Promise.reject(new Error('The connection closed during the transfer.'));
    }
    if (ch.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        ch.removeEventListener('bufferedamountlow', onLow);
        ch.removeEventListener('close', onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('The connection closed during the transfer.'));
      };
      ch.addEventListener('bufferedamountlow', onLow);
      ch.addEventListener('close', onClose);
    });
  }

  async function waitForFlush(ch) {
    while (ch.readyState === 'open' && ch.bufferedAmount > 0) {
      await sleep(40);
    }
    if (ch.readyState !== 'open') {
      throw new Error('The connection closed during the transfer.');
    }
  }

  async function sendFile(item, ch) {
    const file = item.file;
    uid += 1;
    const id = uid + '-' + Date.now();
    ch.send(JSON.stringify({ t: 'meta', id, name: file.name, size: file.size, mime: file.type }));
    let offset = 0;
    while (offset < file.size) {
      const buf = await file.slice(offset, offset + READ_SIZE).arrayBuffer();
      for (let i = 0; i < buf.byteLength; i += CHUNK_SIZE) {
        await waitForBuffer(ch);
        ch.send(buf.slice(i, i + CHUNK_SIZE));
      }
      offset += buf.byteLength;
      setProgress(item, offset / file.size);
    }
    ch.send(JSON.stringify({ t: 'end', id }));
    await waitForFlush(ch);
  }

  async function sendQueue() {
    const ch = dc;
    if (!ch || ch.readyState !== 'open' || sending) return;
    sending = true;
    updateSendControls();
    for (const item of queue.slice()) {
      if (item.state !== 'queued' || queue.indexOf(item) === -1) continue;
      setItemState(item, 'sending', 'Sending 0%');
      try {
        await sendFile(item, ch);
        setProgress(item, 1);
        setItemState(item, 'sent', 'Sent');
      } catch (err) {
        setItemState(item, 'error', 'Failed');
        showMsg(err && err.message ? err.message : String(err), 'error');
        break;
      }
    }
    sending = false;
    updateSendControls();
  }

  function handleMessage(data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg && msg.t === 'meta') startReceive(msg);
      else if (msg && msg.t === 'end') finishReceive(msg.id);
      return;
    }
    if (data instanceof ArrayBuffer) receiveChunk(data);
  }

  function startReceive(meta) {
    if (incoming) failReceive('Interrupted');
    const size = Number(meta.size);
    if (!Number.isFinite(size) || size < 0) return;
    const name = safeName(meta.name);
    const li = el('li', 'row');
    li.dataset.state = 'receiving';
    const nameEl = el('span', 'row-name', name);
    nameEl.title = name;
    const metaEl = el('span', 'row-meta', formatBytes(size));
    const stateEl = el('span', 'row-state', 'Receiving 0%');
    const action = el('span', 'row-action');
    const parts = buildBar();
    li.append(nameEl, metaEl, stateEl, action, parts.bar);
    recvEmpty.hidden = true;
    recvList.hidden = false;
    recvList.insertBefore(li, recvList.firstChild);
    incoming = {
      id: meta.id,
      name,
      size,
      mime: typeof meta.mime === 'string' && meta.mime ? meta.mime : 'application/octet-stream',
      chunks: [],
      got: 0,
      last: 0,
      ui: { li, state: stateEl, fill: parts.fill, action }
    };
  }

  function receiveChunk(buf) {
    if (!incoming) return;
    incoming.chunks.push(buf);
    incoming.got += buf.byteLength;
    const now = performance.now();
    if (now - incoming.last > 80) {
      incoming.last = now;
      const ratio = incoming.size ? incoming.got / incoming.size : 1;
      incoming.ui.fill.style.width = Math.min(100, ratio * 100) + '%';
      incoming.ui.state.textContent = 'Receiving ' + Math.min(100, Math.floor(ratio * 100)) + '%';
    }
  }

  function failReceive(reason) {
    if (!incoming) return;
    incoming.ui.li.dataset.state = 'error';
    incoming.ui.state.textContent = reason;
    incoming.chunks = [];
    incoming = null;
  }

  function triggerDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
  }

  function finishReceive(id) {
    if (!incoming || incoming.id !== id) return;
    const rec = incoming;
    incoming = null;
    if (rec.got !== rec.size) {
      rec.ui.li.dataset.state = 'error';
      rec.ui.state.textContent = 'Incomplete';
      rec.chunks = [];
      return;
    }
    const blob = new Blob(rec.chunks, { type: rec.mime });
    rec.chunks = [];
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    rec.ui.fill.style.width = '100%';
    rec.ui.li.dataset.state = 'done';
    rec.ui.state.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const link = el('a', 'row-link', 'Save again');
    link.href = url;
    link.download = rec.name;
    rec.ui.action.appendChild(link);
    triggerDownload(url, rec.name);
  }

  function selectTab(host) {
    tabHost.setAttribute('aria-selected', String(host));
    tabJoin.setAttribute('aria-selected', String(!host));
    tabHost.tabIndex = host ? 0 : -1;
    tabJoin.tabIndex = host ? -1 : 0;
    paneHost.hidden = !host;
    paneJoin.hidden = host;
  }

  function setMenu(open) {
    creditMenu.hidden = !open;
    creditBtn.setAttribute('aria-expanded', String(open));
  }

  tabHost.addEventListener('click', () => selectTab(true));
  tabJoin.addEventListener('click', () => selectTab(false));
  [tabHost, tabJoin].forEach((tab) => {
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const toHost = tab === tabJoin;
      selectTab(toHost);
      (toHost ? tabHost : tabJoin).focus();
    });
  });

  btnCreate.addEventListener('click', () => run(btnCreate, 'Creating...', createInvite));
  btnFinish.addEventListener('click', () => run(btnFinish, 'Connecting...', finishConnection));
  btnReply.addEventListener('click', () => run(btnReply, 'Generating...', generateReply));
  btnDisconnect.addEventListener('click', disconnect);
  btnCopyInvite.addEventListener('click', () => copyField(inviteOut, btnCopyInvite));
  btnCopyReply.addEventListener('click', () => copyField(replyOut, btnCopyReply));

  btnScanReply.addEventListener('click', () => {
    startScan((code) => {
      replyIn.value = code;
      btnFinish.click();
    });
  });
  btnScanInvite.addEventListener('click', () => {
    startScan((code) => {
      inviteIn.value = code;
      btnReply.click();
    });
  });
  scannerClose.addEventListener('click', closeScanner);
  scanner.addEventListener('click', (e) => {
    if (e.target === scanner) closeScanner();
  });

  scannerPhotoBtn.addEventListener('click', () => {
    if (!scanSession) return;
    stopCamera(scanSession);
    showScannerOverlay('Choose a photo or screenshot of the QR code.', false);
    setScanStatus('', '');
    scannerPhoto.click();
  });
  scannerPhoto.addEventListener('cancel', () => {
    if (scanSession) startScan(scanSession.onCode);
  });
  scannerPhoto.addEventListener('change', async () => {
    const file = scannerPhoto.files && scannerPhoto.files[0];
    scannerPhoto.value = '';
    const session = scanSession;
    if (!file || !session) return;
    setScanStatus('Reading image...', '');
    try {
      const code = await decodePhoto(file);
      if (scanSession !== session) return;
      if (!code) {
        setScanStatus('No Vaultlink QR code found in that image. Make sure the whole code is in the photo and try again.', 'error');
        return;
      }
      closeScanner();
      session.onCode(code);
    } catch (err) {
      if (scanSession === session) setScanStatus(err && err.message ? err.message : 'Could not read that image.', 'error');
    }
  });

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-over');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  btnSend.addEventListener('click', sendQueue);
  btnClear.addEventListener('click', () => {
    queue = queue.filter((item) => {
      if (item.state === 'sending') return true;
      item.ui.li.remove();
      return false;
    });
    updateSendControls();
  });

  creditBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(creditMenu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!creditMenu.hidden && !creditMenu.contains(e.target) && e.target !== creditBtn) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (scanSession) {
      closeScanner();
      return;
    }
    if (!creditMenu.hidden) {
      setMenu(false);
      creditBtn.focus();
    }
  });

  logo.addEventListener('error', () => logo.classList.add('is-missing'));

  window.addEventListener('pagehide', () => {
    closeScanner();
    teardown();
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
  });

  checkEnvironment();
  registerServiceWorker();
  updateSendControls();
})();
