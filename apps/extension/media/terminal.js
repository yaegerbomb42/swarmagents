/**
 * Live terminal drawer controller (plain webview script, no imports, no deps
 * beyond window.Xterm + acquireVsCodeApi + DOM).
 *
 * Owns the drawer DOM under the conversation: an xterm.js canvas when the
 * xterm bundle loaded (out/xterm.js sets window.Xterm), otherwise a minimal
 * <pre> renderer with a small ANSI SGR color parser and a one-line input.
 * Keystrokes go up as terminalInput, resizes as terminalResize; the extension
 * host posts terminalStarted / terminalOutput / terminalExit / terminalSplit.
 * Split view is a body class: conversation left, terminal fixed right.
 */
/* global acquireVsCodeApi, document, window, getComputedStyle, requestAnimationFrame */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var post = function (msg) {
    vscode.postMessage(msg);
  };

  var drawer = null;
  var titleEl = null;
  var statusEl = null;
  var term = null;
  var fitAddon = null;
  var fallbackPre = null;
  var fallbackInput = null;
  var fallbackText = '';
  var sessionId = null;

  var ANSI_SGR = /\x1b\[([0-9;]*)m/g;
  var ANSI_CSI_OTHER = /\x1b\[[0-9;?]*[A-DF-Za-df-z]/g;
  var ANSI_CHARSET = /\x1b[()][0-9A-B]/g;
  var MAX_FALLBACK_CHARS = 8000;

  function themeColor(name, fallback) {
    var value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
  }

  function ensureDrawer() {
    if (drawer) return drawer;
    var composer = document.querySelector('footer.composer');
    drawer = document.createElement('section');
    drawer.id = 'omnexx-terminal';
    drawer.className = 'terminal-drawer';
    drawer.setAttribute('aria-label', 'Live terminal');
    drawer.innerHTML =
      '<div class="terminal-head">' +
      '<button class="t-collapse" type="button" title="Collapse terminal" aria-label="Collapse terminal">▾</button>' +
      '<span class="t-title">Terminal</span>' +
      '<span class="t-status"></span>' +
      '<button class="t-split" type="button" title="Toggle split view (chat | terminal)" aria-label="Toggle split view">◫</button>' +
      '<button class="t-close" type="button" title="Close terminal" aria-label="Close terminal">✕</button>' +
      '</div>' +
      '<div class="terminal-body"><div class="terminal-screen"></div></div>';
    if (composer && composer.parentNode) composer.parentNode.insertBefore(drawer, composer);
    else document.body.appendChild(drawer);
    titleEl = drawer.querySelector('.t-title');
    statusEl = drawer.querySelector('.t-status');
    drawer.querySelector('.t-collapse').addEventListener('click', function () {
      drawer.classList.toggle('collapsed');
      requestAnimationFrame(fit);
    });
    drawer.querySelector('.t-split').addEventListener('click', function () {
      post({ type: 'terminalSplit' });
    });
    drawer.querySelector('.t-close').addEventListener('click', function () {
      post({ type: 'terminalStop' });
      disposeTerm();
      drawer.hidden = true;
    });
    return drawer;
  }

  function disposeTerm() {
    if (term) {
      term.dispose();
      term = null;
      fitAddon = null;
    }
    fallbackPre = null;
    fallbackInput = null;
    fallbackText = '';
  }

  function ensureTerm() {
    if (term || fallbackPre) return;
    var screen = drawer.querySelector('.terminal-screen');
    if (window.Xterm && window.Xterm.Terminal && window.Xterm.FitAddon) {
      var Terminal = window.Xterm.Terminal;
      var FitAddon = window.Xterm.FitAddon;
      term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12,
        theme: {
          background: 'transparent',
          foreground: themeColor('--vscode-terminal-foreground', '#cccccc'),
          cursor: themeColor('--vscode-terminalCursor-foreground', '#ffffff'),
        },
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(screen);
      term.onData(function (data) {
        post({ type: 'terminalInput', data: data });
      });
      term.onResize(function (size) {
        post({ type: 'terminalResize', cols: size.cols, rows: size.rows });
      });
      fit();
      post({ type: 'terminalResize', cols: term.cols, rows: term.rows });
    } else {
      ensureFallback();
    }
  }

  function fit() {
    if (term && fitAddon && drawer && !drawer.hidden && !drawer.classList.contains('collapsed')) {
      try {
        fitAddon.fit();
      } catch (e) {
        // Not laid out yet (drawer still measuring); the next fit fixes it.
      }
    }
  }

  /** Minimal <pre> fallback: SGR colors become spans, other escapes are dropped. */
  function ansiToHtml(text) {
    var stripped = text.replace(ANSI_CSI_OTHER, '').replace(ANSI_CHARSET, '').replace(/\x07/g, '');
    var esc = stripped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var out = '';
    var last = 0;
    var open = false;
    var m;
    ANSI_SGR.lastIndex = 0;
    while ((m = ANSI_SGR.exec(esc)) !== null) {
      out += esc.slice(last, m.index);
      var classes = [];
      var codes = (m[1] || '0').split(';');
      for (var i = 0; i < codes.length; i++) {
        var code = Number(codes[i]);
        if (code === 0) {
          if (open) {
            out += '</span>';
            open = false;
          }
        } else if (code === 1) {
          classes.push('ansi-1');
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          classes.push('ansi-' + String(code));
        }
      }
      if (classes.length) {
        if (open) out += '</span>';
        out += '<span class="' + classes.join(' ') + '">';
        open = true;
      }
      last = m.index + m[0].length;
    }
    out += esc.slice(last);
    if (open) out += '</span>';
    return out;
  }

  function ensureFallback() {
    var body = drawer.querySelector('.terminal-body');
    body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'terminal-fallback-wrap';
    fallbackPre = document.createElement('pre');
    fallbackPre.className = 'terminal-fallback';
    fallbackPre.setAttribute('aria-live', 'polite');
    fallbackInput = document.createElement('input');
    fallbackInput.className = 'terminal-fallback-input';
    fallbackInput.setAttribute('aria-label', 'Terminal input');
    fallbackInput.setAttribute('placeholder', 'Type a command and press Enter…');
    fallbackInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        post({ type: 'terminalInput', data: fallbackInput.value + '\n' });
        fallbackInput.value = '';
      }
    });
    wrap.appendChild(fallbackPre);
    wrap.appendChild(fallbackInput);
    body.appendChild(wrap);
  }

  function appendFallback(chunk) {
    if (!fallbackPre) return;
    fallbackText += chunk;
    if (fallbackText.length > MAX_FALLBACK_CHARS) {
      fallbackText = fallbackText.slice(fallbackText.length - MAX_FALLBACK_CHARS);
    }
    fallbackPre.innerHTML = ansiToHtml(fallbackText);
    fallbackPre.scrollTop = fallbackPre.scrollHeight;
  }

  function onStarted(m) {
    sessionId = typeof m.id === 'string' ? m.id : null;
    ensureDrawer();
    drawer.hidden = false;
    drawer.classList.remove('collapsed');
    if (titleEl)
      titleEl.textContent = 'Terminal — ' + (typeof m.command === 'string' ? m.command : 'shell');
    if (statusEl) statusEl.textContent = '';
    ensureTerm();
    fit();
  }

  function onOutput(m) {
    if (typeof m.data !== 'string') return;
    if (typeof m.id === 'string' && sessionId && m.id !== sessionId) return;
    if (term) term.write(m.data);
    else appendFallback(m.data);
  }

  function onExit(m) {
    if (typeof m.id === 'string' && sessionId && m.id !== sessionId) return;
    sessionId = null;
    var code = typeof m.code === 'number' ? m.code : null;
    var label = code === null ? 'exited' : 'exit ' + String(code);
    if (statusEl) statusEl.textContent = label;
    var line = '\r\n[' + label + ']\r\n';
    if (term) term.write(line);
    else appendFallback(line);
  }

  function onSplit(m) {
    var on = m.on === true;
    document.body.classList.toggle('split-view', on);
    var splitBtn = drawer ? drawer.querySelector('.t-split') : null;
    if (splitBtn) splitBtn.setAttribute('aria-pressed', String(on));
    if (on) {
      ensureDrawer();
      drawer.hidden = false;
      if (!sessionId) post({ type: 'terminalStart' });
    }
    requestAnimationFrame(fit);
  }

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'terminalStarted') onStarted(m);
    else if (m.type === 'terminalOutput') onOutput(m);
    else if (m.type === 'terminalExit') onExit(m);
    else if (m.type === 'terminalSplit') onSplit(m);
  });

  window.addEventListener('resize', function () {
    fit();
  });
})();
