export interface SimulatorWebviewAssets {
	cspSource: string;
	crownUri: string;
	sideButtonUri: string;
}

export function getSimulatorWebviewHtml(nonce: string, width: number, height: number, streamUrl: string, assets: SimulatorWebviewAssets): string {
	const websocketOrigin = new URL(streamUrl).origin;
	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${websocketOrigin}; img-src data: ${assets.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background, #1e1e1e); }
body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
#status { color: var(--vscode-descriptionForeground, #888); font: 12px var(--vscode-font-family, sans-serif); min-height: 16px; }
#stage { position: relative; width: 500px; height: 520px; max-width: calc(100vw - 24px); max-height: calc(100vh - 40px); }
#native-surface { position: absolute; left: 50%; top: 50%; width: 500px; height: 520px; transform: translate(-50%, -50%) scale(1); transform-origin: center center; }
#watch-frame { position: absolute; z-index: 1; left: 35px; top: 15px; width: 430px; height: 490px; box-sizing: border-box; border-radius: 100px; background: #000; outline: 10px solid #1f1f1f; outline-offset: -2px; pointer-events: none; }
canvas { position: absolute; left: 55px; top: 35px; width: 390px; height: 450px; border-radius: 80px; background: #000; image-rendering: auto; touch-action: none; user-select: none; z-index: 2; }
.hardware-button { position: absolute; z-index: 3; display: block; border: 0; padding: 0; cursor: pointer; appearance: none; background: transparent; outline: none; }
.hardware-button img { display: block; width: 100%; height: 100%; pointer-events: none; }
.hardware-button:active { filter: brightness(1.15); }
#crown { left: 467px; top: 130px; width: 25px; height: 65px; }
#side-button { left: 470px; top: 290px; width: 13px; height: 99px; }
</style></head><body>
<div id="status">Waiting for Simulator…</div><div id="stage"><div id="native-surface"><div id="watch-frame"></div><canvas id="screen" width="${width}" height="${height}"></canvas><button id="crown" class="hardware-button" aria-label="Crown"><img src="${assets.crownUri}" alt=""></button><button id="side-button" class="hardware-button" aria-label="Side button"><img src="${assets.sideButtonUri}" alt=""></button></div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi(); const canvas = document.getElementById('screen'); const crown = document.getElementById('crown'); const sideButton = document.getElementById('side-button'); const streamUrl = ${JSON.stringify(streamUrl)};
const status = document.getElementById('status');
const stage = document.getElementById('stage'); const nativeSurface = document.getElementById('native-surface');
let logicalWidth = ${width}; let logicalHeight = ${height}; const frameStride = ${width * 2}; let pointerActive = false; let connected = false; let latestFrame; let renderScheduled = false;
let renderedFrames = 0; let fpsWindowStart = performance.now();
function setStatus(text) { status.textContent = text; }
function layoutNativeSurface() { const availableWidth = Math.max(1, Math.min(500, window.innerWidth - 24)); const availableHeight = Math.max(1, Math.min(520, window.innerHeight - 40)); const scale = Math.min(availableWidth / 500, availableHeight / 520); stage.style.width = (500 * scale) + 'px'; stage.style.height = (520 * scale) + 'px'; nativeSurface.style.transform = 'translate(-50%, -50%) scale(' + scale + ')'; }
window.addEventListener('resize', layoutNativeSurface); layoutNativeSurface();
function pointerPosition(event) { const rect = canvas.getBoundingClientRect(); return {
  x: Math.max(0, Math.min(logicalWidth - 1, Math.floor((event.clientX - rect.left) * logicalWidth / rect.width))),
  y: Math.max(0, Math.min(logicalHeight - 1, Math.floor((event.clientY - rect.top) * logicalHeight / rect.height))) }; }
function sendPointer(action, event) { const point = pointerPosition(event); if (socket && socket.readyState === WebSocket.OPEN)
  socket.send(JSON.stringify({ type: 'input', action, x: point.x, y: point.y })); }
function sendButton(button, action = 'click') { if (socket && socket.readyState === WebSocket.OPEN)
  socket.send(JSON.stringify({ type: 'button', button, action })); }
function compileShader(gl, type, source) { const shader = gl.createShader(type); if (!shader) return null;
  gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
  return shader; }
function createRgb565Renderer() {
  const options = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, desynchronized: true, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
  if (!gl) return null;
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, webgl2
    ? '#version 300 es\\n' + 'in vec2 aPosition; in vec2 aTexCoord; out vec2 vTexCoord;\\n' +
      'void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vTexCoord = aTexCoord; }'
    : 'attribute vec2 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord;\\n' +
      'void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vTexCoord = aTexCoord; }');
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, webgl2
    ? '#version 300 es\\n' + 'precision highp float; uniform sampler2D uFrame; in vec2 vTexCoord; out vec4 outColor;\\n' +
      'void main() { vec2 bytes = texture(uFrame, vTexCoord).rg * 255.0; float color = bytes.r + bytes.g * 256.0;\\n' +
      'float red = floor(color / 2048.0); float green = floor(mod(color, 2048.0) / 32.0); float blue = mod(color, 32.0);\\n' +
      'outColor = vec4(red / 31.0, green / 63.0, blue / 31.0, 1.0); }'
    : 'precision mediump float; uniform sampler2D uFrame; varying vec2 vTexCoord;\\n' +
      'void main() { vec2 bytes = texture2D(uFrame, vTexCoord).ra * 255.0; float color = bytes.r + bytes.g * 256.0;\\n' +
      'float red = floor(color / 2048.0); float green = floor(mod(color, 2048.0) / 32.0); float blue = mod(color, 32.0);\\n' +
      'gl_FragColor = vec4(red / 31.0, green / 63.0, blue / 31.0, 1.0); }');
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram(); if (!program) return null;
  gl.attachShader(program, vertexShader); gl.attachShader(program, fragmentShader); gl.linkProgram(program);
  gl.deleteShader(vertexShader); gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
  const position = gl.createBuffer(); const texCoord = gl.createBuffer(); const texture = gl.createTexture();
  if (!position || !texCoord || !texture) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, position); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, 'aPosition'); gl.enableVertexAttribArray(positionLocation); gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoord); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), gl.STATIC_DRAW);
  const texCoordLocation = gl.getAttribLocation(program, 'aTexCoord'); gl.enableVertexAttribArray(texCoordLocation); gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'uFrame'), 0); gl.activeTexture(gl.TEXTURE0);
  let textureWidth = 0; let textureHeight = 0;
  return (bytes, frameWidth, frameHeight, stride) => {
    if (canvas.width !== frameWidth || canvas.height !== frameHeight) { canvas.width = frameWidth; canvas.height = frameHeight; }
    gl.viewport(0, 0, frameWidth, frameHeight); gl.bindTexture(gl.TEXTURE_2D, texture);
    if (webgl2) gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / 2);
    const format = webgl2 ? gl.RG : gl.LUMINANCE_ALPHA;
    const internalFormat = webgl2 ? gl.RG8 : gl.LUMINANCE_ALPHA;
    if (textureWidth !== frameWidth || textureHeight !== frameHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, frameWidth, frameHeight, 0, format, gl.UNSIGNED_BYTE, bytes); textureWidth = frameWidth; textureHeight = frameHeight;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frameWidth, frameHeight, format, gl.UNSIGNED_BYTE, bytes);
    if (webgl2) gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}
const renderRgb565 = createRgb565Renderer(); const renderMode = renderRgb565 ? 'WebGL' : 'Canvas 2D'; const context = renderRgb565 ? null : canvas.getContext('2d', { alpha: false });
function drawFrame(bytes, width, height, stride) { logicalWidth = width; logicalHeight = height;
  if (renderRgb565) { renderRgb565(bytes, width, height, stride); return; }
  if (!context) return; if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const image = context.createImageData(width, height); for (let row = 0, target = 0; row < height; row++) for (let column = 0; column < width; column++, target += 4) {
    const source = row * stride + column * 2; if (source + 1 >= bytes.length) return;
    const color = bytes[source] | (bytes[source + 1] << 8); image.data[target] = Math.round(((color >> 11) & 0x1f) * 255 / 31);
    image.data[target + 1] = Math.round(((color >> 5) & 0x3f) * 255 / 63); image.data[target + 2] = Math.round((color & 0x1f) * 255 / 31); image.data[target + 3] = 255; }
  context.putImageData(image, 0, 0); }
canvas.addEventListener('pointerdown', event => { pointerActive = true; canvas.setPointerCapture(event.pointerId); sendPointer('down', event); event.preventDefault(); });
canvas.addEventListener('pointermove', event => { if (pointerActive) sendPointer('move', event); event.preventDefault(); });
function releasePointer(event) { if (!pointerActive) return; pointerActive = false; sendPointer('up', event); event.preventDefault(); }
canvas.addEventListener('pointerup', releasePointer); canvas.addEventListener('pointercancel', releasePointer);
function bindHardwareButton(element, button) { let longPress = false; let timer;
  element.addEventListener('pointerdown', event => { longPress = false; element.setPointerCapture(event.pointerId);
    if (button === 'crown') timer = setTimeout(() => { longPress = true; sendButton('crown', 'longPress'); }, 500); event.preventDefault(); });
  const release = event => { if (timer) { clearTimeout(timer); timer = undefined; } if (!longPress) sendButton(button); event.preventDefault(); };
  element.addEventListener('pointerup', release); element.addEventListener('pointercancel', release);
}
bindHardwareButton(crown, 'crown'); bindHardwareButton(sideButton, 'side');
function scheduleRender() { if (renderScheduled) return; renderScheduled = true; requestAnimationFrame(renderLatestFrame); }
function renderLatestFrame() { renderScheduled = false; const frame = latestFrame; latestFrame = undefined; if (!frame) return;
  drawFrame(frame.bytes, frame.width, frame.height, frame.stride); renderedFrames++; const now = performance.now();
  if (now - fpsWindowStart >= 1000) { setStatus((connected ? 'Connected · ' : 'Rendering · ') + renderMode + ' · ' + renderedFrames + ' FPS'); renderedFrames = 0; fpsWindowStart = now; }
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'presented' })); if (latestFrame) scheduleRender(); }
const socket = new WebSocket(streamUrl); socket.binaryType = 'arraybuffer';
socket.addEventListener('open', () => { connected = true; setStatus('Connected · ' + renderMode); });
socket.addEventListener('close', () => { connected = false; setStatus('Simulator disconnected'); vscode.postMessage({ type: 'connectionLost', viewId: ${JSON.stringify(nonce)} }); });
socket.addEventListener('error', () => { if (!connected) setStatus('WebSocket connection failed'); });
socket.addEventListener('message', event => { if (!(event.data instanceof ArrayBuffer)) return; const bytes = new Uint8Array(event.data);
  if (bytes.length < frameStride * logicalHeight) return; latestFrame = { bytes, width: logicalWidth, height: logicalHeight, stride: frameStride }; scheduleRender(); });
window.addEventListener('message', event => { const message = event.data; if (message.type === 'status') setStatus(message.text); });
</script></body></html>`;
}
