(function () {
  'use strict';

  const CHUNK_SIZE = 16384;
  const READ_SIZE = 262144;
  const BUFFER_HIGH = 1048576;
  const BUFFER_LOW = 262144;
  const ICE_GATHER_TIMEOUT = 7000;
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
  const btnDisconnect = $('btn-disconnect');
  const btnCopyInvite = $('btn-copy-invite');
  const btnCopyReply = $('btn-copy-reply');
  const inviteOut = $('invite-out');
  const replyIn = $('reply-in');
  const inviteIn = $('invite-in');
  const replyOut = $('reply-out');
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

  function checkEnvironment() {
    const lines = [];
    if (location.protocol === 'file:') {
      lines.push('This page was opened from a file:// address. WebRTC needs http://localhost or https://. Serve this folder, for example with "python3 -m http.server 8000", then open http://localhost:8000.');
    } else if (window.isSecureContext === false) {
      lines.push('This page is not in a secure context. WebRTC and clipboard access need http://localhost or https://.');
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
      let timer = null;
      const finish = () => {
        clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (peer.iceGatheringState === 'complete') finish();
      };
      timer = setTimeout(finish, ICE_GATHER_TIMEOUT);
      peer.addEventListener('icegatheringstatechange', check);
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

  function setOutput(field, btn, value) {
    field.value = value;
    btn.disabled = !value;
  }

  function resetSignaling() {
    setOutput(inviteOut, btnCopyInvite, '');
    setOutput(replyOut, btnCopyReply, '');
    replyIn.value = '';
    inviteIn.value = '';
  }

  function setConnected(on) {
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
    setOutput(inviteOut, btnCopyInvite, '');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForGathering(peer);
    if (peer !== pc) return;
    setOutput(inviteOut, btnCopyInvite, encodeDescription(peer.localDescription));
    showMsg('Invite ready. Copy it, send it, then paste the reply you get back.', 'ok');
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
    setOutput(replyOut, btnCopyReply, '');
    await peer.setRemoteDescription(remote);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForGathering(peer);
    if (peer !== pc) return;
    setOutput(replyOut, btnCopyReply, encodeDescription(peer.localDescription));
    showMsg('Reply ready. Copy it and send it back. This page connects once they finish.', 'ok');
  }

  function disconnect() {
    failReceive('Disconnected');
    teardown();
    setConnected(false);
    resetSignaling();
    clearMsg();
    setStatus('idle', 'Not connected');
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
    if (e.key === 'Escape' && !creditMenu.hidden) {
      setMenu(false);
      creditBtn.focus();
    }
  });

  logo.addEventListener('error', () => logo.classList.add('is-missing'));

  window.addEventListener('pagehide', () => {
    teardown();
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
  });

  checkEnvironment();
  updateSendControls();
})();
