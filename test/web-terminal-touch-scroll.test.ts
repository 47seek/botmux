import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

function scriptBlock(startMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf('</script>', start);
  expect(start).toBeGreaterThan(-1);
  return workerSource.slice(start, end);
}

describe('web terminal touch scrolling', () => {
  it('uses snapshot replacement for every Herdr CLI, including normal-buffer Codex', () => {
    expect(workerSource).toContain('return backend instanceof HerdrBackend;');
    expect(workerSource).toContain('if (be instanceof HerdrBackend) {');
    expect(workerSource).toContain('wireHerdrWebTerminalRelays(herdrBe);');
    expect(workerSource).toContain(
      'if (backend instanceof HerdrBackend) {\n'
      + '    wireHerdrWebTerminalRelays(backend);\n'
      + '    restoreHerdrWebBindings();',
    );
  });

  it('restores the real Herdr attach cursor after snapshot rendering', () => {
    expect(workerSource).toContain('be.onWebTerminalCursor(relayHerdrWebCursor);');
    expect(workerSource).toContain('scrollback}${herdrWebCursorSequence()}');
    expect(workerSource).toContain('ws.send(seed + herdrWebCursorSequence());');
  });

  it('forces Herdr alternate-screen CLIs to remote-scroll after a snapshot-only refresh', () => {
    expect(workerSource).toContain("effectiveBackendType === 'herdr' && cliAdapter?.altScreen === true");
    expect(workerSource).toContain('var remoteScroll=${forceRemoteScroll};');

    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    expect(wheelBlock).toContain('if(_canScrollLocal(px)){');
    expect(wheelBlock.indexOf('if(_canScrollLocal(px)){'))
      .toBeLessThan(wheelBlock.indexOf('_fwdScroll(px,_cellAt'));
  });

  it('caps the burst on the Herdr backend, not on remoteScroll/altScreen', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');

    // Cap gated on herdrBackend (the expensive send-text+snapshot path), NOT on
    // remoteScroll — which also encodes altScreen and would leave a Herdr session
    // running an altScreen:false CLI (Claude/Codex) uncapped once it enters the
    // alternate buffer at runtime.
    expect(wheelBlock).toContain('var _SCROLL_BURST_MAX=herdrBackend?6:Infinity');
    expect(wheelBlock).not.toContain('_SCROLL_BURST_MAX=remoteScroll');
    expect(wheelBlock).toContain('_scrollBurstTicks<_SCROLL_BURST_MAX');
    expect(wheelBlock).toContain('setTimeout(_endScrollBurst,_SCROLL_BURST_IDLE_MS)');
    expect(wheelBlock).toContain('if(_scrollBurstTicks>=_SCROLL_BURST_MAX)_scrollAccum=0');
  });

  it('derives herdrBackend from the backend alone, independent of altScreen', () => {
    // forceRemoteScroll still requires altScreen; herdrBackend must NOT — the cap
    // has to hold for a runtime alt-buffer under an altScreen:false Herdr CLI.
    expect(workerSource).toContain(
      "const herdrBackend = effectiveBackendType === 'herdr';",
    );
    expect(workerSource).toContain(
      'getTerminalHtml(hasWrite, platformReadonly, loginUrl, forceRemoteScroll, herdrBackend)',
    );
    expect(workerSource).toContain('var herdrBackend=${herdrBackend};');
  });

  it('forwards wheel ticks proportionally when uncapped, and caps Herdr', () => {
    // Extract the real burst-accumulation loop from the source so the test moves
    // when the algorithm moves, then run it for both backends.
    function runSpin(herdrBackend: boolean, notches: number, pxPerNotch: number) {
      const _SCROLL_STEP = 33;
      const _SCROLL_BURST_MAX = herdrBackend ? 6 : Infinity;
      let _scrollAccum = 0;
      let _scrollBurstTicks = 0;
      let _scrollBurstDir = 0;
      let emitted = 0;
      for (let i = 0; i < notches; i++) {
        const px = pxPerNotch; // steady downward spin
        const dir = px < 0 ? -1 : 1;
        if (_scrollBurstDir && dir !== _scrollBurstDir) { _scrollAccum = 0; _scrollBurstTicks = 0; }
        _scrollBurstDir = dir;
        if (_scrollBurstTicks >= _SCROLL_BURST_MAX) continue;
        _scrollAccum += px;
        let n = 0;
        while (Math.abs(_scrollAccum) >= _SCROLL_STEP && n < 6 && _scrollBurstTicks < _SCROLL_BURST_MAX) {
          const up = _scrollAccum < 0;
          _scrollAccum += up ? _SCROLL_STEP : -_SCROLL_STEP;
          n++; _scrollBurstTicks++; emitted++;
        }
        if (_scrollBurstTicks >= _SCROLL_BURST_MAX) _scrollAccum = 0;
      }
      return emitted;
    }

    // Local PTY/tmux (herdrBackend=false): 40 notches @100px scale with distance,
    // never freeze. Old cap of 6 would have frozen it after ~2 notches.
    const local = runSpin(false, 40, 100);
    expect(local).toBe(Math.floor((40 * 100) / 33)); // 121
    expect(local).toBeGreaterThan(100);

    // Herdr backend: still capped at 6 no matter how long the spin.
    expect(runSpin(true, 40, 100)).toBe(6);
    expect(runSpin(true, 2, 100)).toBe(6); // reaches cap within the first notches
  });

  it('uses local scrollback before requesting another remote history chunk', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(wheelBlock).toContain('function _canScrollLocal(px){');
    expect(wheelBlock).toContain("if(b.type==='alternate'||!px)return false");
    expect(wheelBlock).toContain('return px>0||b.viewportY>0');
    expect(wheelBlock).toContain('if(_canScrollLocal(px)){');
    expect(touchBlock).toContain('if(_canScrollLocal(px)){');
  });

  it('replaces merged Herdr history and preserves the reader anchor', () => {
    expect(workerSource).toContain('1989;history;${merged.addedLines}');
    expect(workerSource).toContain("var _hh=data.match(/^\\x1b\\]1989;history;([0-9]+)\\x07/)");
    expect(workerSource).toContain('data=data.slice(_hh[0].length);_cancelInitialFollow();term.reset();term.clear()');
    expect(workerSource).toContain("data='\\\\x1b[2J\\\\x1b[H'+data");
    expect(workerSource).toContain('if(_ha>0)term.scrollToLine(_hy+_ha)');
  });

  it('drives normal-buffer scroll explicitly instead of relying on WebView defaults', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain("var _tViewport=document.querySelector('#terminal .xterm-viewport')");
    expect(touchBlock).toContain('if(_canScrollLocal(px)){');
    expect(touchBlock).toContain('_tViewport.scrollTop-=y-_tLastY');
    expect(touchBlock.indexOf('if(_canScrollLocal(px)){'))
      .toBeLessThan(touchBlock.indexOf('_fwdScroll(px'));
  });

  it('prevents xterm from double-driving handled single-touch moves', () => {
    const touchBlock = scriptBlock('// Single-finger touch scrolling:');

    expect(touchBlock).toContain('e.preventDefault();e.stopPropagation();');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchmove'");
    expect(touchBlock).toContain('{capture:true,passive:false}');
    expect(touchBlock).toContain("_tTerm.addEventListener('touchend',function(){_tLastY=null;_endScrollBurst()}");
  });
});
