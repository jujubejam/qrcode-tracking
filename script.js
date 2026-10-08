const video = document.getElementById('webcam');
const cameraSelect = document.getElementById('cameraSelect');
const stage = document.getElementById('stage');
const stageCtx = stage.getContext('2d');
const statusEl = document.getElementById('status');
const detectedCodesEl = document.getElementById('detectedCodes');

function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image;
}

// Only these specific physical tokens get a portal; any other code is
// tracked (for calibration/detection purposes) but shows nothing.
const PORTAL_IMAGES_BY_DATA = {
  phone: loadImage('portal_cool.png'),
  'object-a': loadImage('portal_warm.png'),
};

// Human-readable names for the same recognized characters, used for the
// on-screen nameplate, the spoken announcement, and the "X is Y" land
// readout. Key order matters: it's the order names appear in when several
// characters share a land ("JuJu and 雨轩 are doing great").
const CHARACTER_NAMES = {
  'object-a': 'JuJu',
  phone: '雨轩',
};

function hasCJK(text) {
  return /[一-鿿]/.test(text);
}

// Speaks one utterance, auto-detecting a Chinese voice for CJK text so it's
// pronounced correctly rather than mangled by an English voice. Consecutive
// speak() calls are queued by the browser and play back-to-back, which is
// used to mix a CJK name with an English phrase in a single announcement
// (see announceLand) without either part being read in the wrong voice.
function speak(text) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  if (hasCJK(text)) {
    utterance.lang = 'zh-CN';
  }
  speechSynthesis.speak(utterance);
}

// Speaks a sentence assembled from separate parts, merging neighbors of the
// same script into one utterance so e.g. ["JuJu", "and", "雨轩", "are doing
// great"] becomes "JuJu and" (English) -> "雨轩" (Chinese) -> "are doing
// great" (English), each in the right voice with as few pauses as possible.
function speakParts(parts) {
  const groups = [];
  for (const part of parts) {
    const cjk = hasCJK(part);
    const last = groups[groups.length - 1];
    if (last && last.cjk === cjk) {
      last.text += ` ${part}`;
    } else {
      groups.push({ text: part, cjk });
    }
  }
  groups.forEach((group) => speak(group.text));
}

// A character counts as having left the screen once it hasn't been seen for
// this long. That's longer than any brief detection flicker (the code
// dropping out of trackedTokens for just over TOKEN_PERSISTENCE_MS, then
// reappearing), which would otherwise look identical to leaving and coming
// back. It has two consequences: a character that comes back after this long
// is announced by name again (re-announcing on every flicker piles up in
// speechSynthesis's queue and keeps playing after the token is gone), and a
// character that's been gone this long is no longer "in" any land.
const LEFT_SCREEN_AFTER_MS = 3000;
const lastSeenAt = new Map();

function isOnScreen(data, now = performance.now()) {
  return now - (lastSeenAt.get(data) ?? -Infinity) < LEFT_SCREEN_AFTER_MS;
}

// Reads a character's name aloud when its portal first appears (see the
// isNewSighting check in updateTrackedTokens).
function announceCharacter(data) {
  const name = CHARACTER_NAMES[data];
  if (name) {
    speak(name);
  }
}

// Reads "<name> is <land>" aloud once, the moment a character's land
// assignment is first set or changes (see updateCharacterLands) — not on
// every frame it stays on the same land. Split into two utterances so a
// CJK name and the English land phrase are each spoken in the right voice.
function announceLand(data, land) {
  const name = CHARACTER_NAMES[data];
  if (name) {
    speak(name);
    speak(`is ${land}`);
  }
}

// readBarcodes() fetches and instantiates the wasm module lazily on its
// first call, which would otherwise stall the very first real frame.
// Kicking that off immediately on load means it's ready well before the
// camera stream and first video frame are. Wrapped defensively: if this
// library fails to load or init for any reason, that must never be able to
// block camera access (an unrelated, more important concern) by throwing
// an uncaught error here.
try {
  ZXingWASM.prepareZXingModule({ fireImmediately: true });
} catch (error) {
  console.error('Failed to initialize zxing-wasm:', error);
}

let sampleCanvas;
let sampleCtx;
let tickLoopStarted = false;
let latestDetections = [];

// Token QR scanning runs on a downscaled copy of the frame rather than the
// full capture resolution, purely to cut the number of pixels zxing-wasm
// has to examine per frame. Corner-marker (ArUco) detection is unrelated
// and still runs on the full-resolution frame, unchanged.
const DETECTION_MAX_WIDTH = 1280;
let detectionCanvas;
let detectionCtx;
let detectionScale = 1;

// readBarcodes() is async and, per frame, meaningfully slower than a
// synchronous call — awaiting it inline in the render loop would stall
// rendering. Instead it's kicked off without blocking tick(), and this
// flag stops a new scan from starting while one is still in flight (so a
// slow frame can't pile up a backlog of overlapping scans).
let detectionInFlight = false;

// Rolling once-a-second readout of how often a scan actually decodes
// something, to distinguish "detection is genuinely unreliable right now"
// from other causes of a missing portal.
let scansThisWindow = 0;
let successesThisWindow = 0;
let statsWindowStart = performance.now();
const detectionRateEl = document.getElementById('detectionRate');

function recordScanResult(succeeded) {
  scansThisWindow += 1;
  if (succeeded) {
    successesThisWindow += 1;
  }

  const now = performance.now();
  if (now - statsWindowStart >= 1000) {
    detectionRateEl.textContent = `Decode rate: ${successesThisWindow}/${scansThisWindow} frames/sec`;
    scansThisWindow = 0;
    successesThisWindow = 0;
    statsWindowStart = now;
  }
}

// Decoded data is matched exactly, so incidental whitespace or casing from
// however a code was generated (e.g. "Phone " vs "phone") would otherwise
// silently fail to match anything in PORTAL_IMAGES_BY_DATA.
function normalizeData(data) {
  return (data || '').trim().toLowerCase();
}

// A code missing from one frame's scan (motion blur, a brief bad decode,
// etc.) shouldn't make its portal flicker off. Each detected code's last
// known location is kept for a grace period after it stops being seen, and
// only dropped once that expires.
const TOKEN_PERSISTENCE_MS = 400;
const trackedTokens = new Map();

function updateTrackedTokens(detections) {
  const now = performance.now();

  for (const detection of detections) {
    const data = normalizeData(detection.data);
    const isNewSighting = !trackedTokens.has(data);
    const absentMs = now - (lastSeenAt.get(data) ?? -Infinity);
    trackedTokens.set(data, { data, location: detection.location, lastSeen: now });
    lastSeenAt.set(data, now);

    if (isNewSighting && absentMs >= LEFT_SCREEN_AFTER_MS) {
      announceCharacter(data);
    }
  }

  for (const [data, token] of trackedTokens) {
    if (now - token.lastSeen > TOKEN_PERSISTENCE_MS) {
      trackedTokens.delete(data);
    }
  }

  detectedCodesEl.textContent = trackedTokens.size
    ? `Seen: ${[...trackedTokens.keys()].map((data) => `"${data}"`).join(', ')}`
    : '';
}

// Maps a point in the camera's pixel space onto the screen's pixel space, so
// a code's position as seen from above corresponds to where it physically
// sits on the display. Recomputed continuously; see updateHomography().
let homography = null;

// Fixed ArUco markers rendered at the four known screen corners. ArUco
// markers are built for exactly this: tracking-camera detection at odd
// angles, distances and lighting, which QR codes (tuned for someone holding
// a phone up close) are much less reliable at, especially stuck in the
// corner of a frame. Detecting all four in a frame gives four (camera
// position, screen position) correspondences, enough to (re)solve the
// homography, so calibration stays correct even if the camera or screen
// moves. Physical tokens placed on the display are still tracked as QR
// codes (see scanForQRCodes), since those benefit from carrying arbitrary
// data rather than just a small fixed ID.
const CORNER_MARKERS = [
  { element: document.getElementById('cornerTL'), id: 0 },
  { element: document.getElementById('cornerTR'), id: 1 },
  { element: document.getElementById('cornerBR'), id: 2 },
  { element: document.getElementById('cornerBL'), id: 3 },
];

const arDictionary = new AR.Dictionary('ARUCO_MIP_36h12');
const arDetector = new AR.Detector();

for (const marker of CORNER_MARKERS) {
  marker.element.innerHTML = arDictionary.generateSVG(marker.id);
}

// Three static status QR codes placed on the display itself. Unlike the
// corner markers (used for calibration) and tracked tokens (physical
// objects placed on the surface), these are just fixed, labeled codes shown
// on screen — e.g. for someone to scan directly with a phone.
const STATUS_MARKERS = [
  { element: document.getElementById('statusQR1'), data: 'doing great' },
  { element: document.getElementById('statusQR2'), data: 'alright' },
  { element: document.getElementById('statusQR3'), data: 'SOS' },
];

for (const marker of STATUS_MARKERS) {
  const qr = qrcode(0, 'L');
  qr.addData(marker.data);
  qr.make();
  marker.element.innerHTML = qr.createSvgTag(4, 0);
}

// Each status marker has a square "land" around it (the dashed box drawn in
// CSS). A recognized character (a token with a portal image) standing in
// one is considered "on" that land. characterLands remembers the last land
// each character was seen on, which is what lets a land change be told apart
// from just moving around within (or outside of) one. Whether a character is
// actually *in* its remembered land right now also requires it to still be
// on screen (see isOnScreen).
const LANDS = [
  { element: document.getElementById('landZone1'), name: 'doing great' },
  { element: document.getElementById('landZone2'), name: 'alright' },
  { element: document.getElementById('landZone3'), name: 'SOS' },
];

const characterLands = new Map();
const characterLandsEl = document.getElementById('characterLands');

function elementRect(element) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function landContaining(point) {
  for (const land of LANDS) {
    const rect = elementRect(land.element);
    if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
      return land.name;
    }
  }
  return null;
}

function updateCharacterLands() {
  for (const { data, location } of trackedTokens.values()) {
    if (!PORTAL_IMAGES_BY_DATA[data] || !homography) {
      continue;
    }

    const land = landContaining(applyHomography(homography, centerOf(location)));
    if (land && characterLands.get(data) !== land) {
      characterLands.set(data, land);
      announceLand(data, land);
    }
  }

  const now = performance.now();
  characterLandsEl.textContent = [...characterLands.entries()]
    .filter(([data]) => isOnScreen(data, now))
    .map(([data, land]) => `${CHARACTER_NAMES[data] || data} is ${land}`)
    .join('  |  ');
}

function videoConstraints(deviceId) {
  return {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    audio: false,
  };
}

let currentStream;

async function startStream(deviceId) {
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
  }

  currentStream = await navigator.mediaDevices.getUserMedia(videoConstraints(deviceId));
  video.srcObject = currentStream;
}

async function populateCameraOptions() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');

  cameraSelect.innerHTML = '';
  for (const camera of cameras) {
    const option = document.createElement('option');
    option.value = camera.deviceId;
    option.textContent = camera.label || `Camera ${cameraSelect.length + 1}`;
    cameraSelect.appendChild(option);
  }

  cameraSelect.value = currentStream.getVideoTracks()[0]?.getSettings().deviceId;
}

cameraSelect.addEventListener('change', () => {
  startStream(cameraSelect.value);
});

startStream()
  .then(populateCameraOptions)
  .catch((error) => {
    console.error('Unable to access camera:', error);
  });

function resizeStage() {
  stage.width = window.innerWidth;
  stage.height = window.innerHeight;
}

window.addEventListener('resize', resizeStage);
resizeStage();

video.addEventListener('loadedmetadata', () => {
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  detectionScale = Math.min(1, DETECTION_MAX_WIDTH / video.videoWidth);
  detectionCanvas = document.createElement('canvas');
  detectionCanvas.width = Math.round(video.videoWidth * detectionScale);
  detectionCanvas.height = Math.round(video.videoHeight * detectionScale);
  detectionCtx = detectionCanvas.getContext('2d', { willReadFrequently: true });

  if (!tickLoopStarted) {
    tickLoopStarted = true;
    requestAnimationFrame(tick);
  }
});

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const frame = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
    updateHomography(frame);

    // Fire-and-forget: scanForQRCodes() is async, and this loop shouldn't
    // stall waiting on it. Rendering (below) always uses whatever the most
    // recently completed scan found.
    scanForQRCodes();
    detectPointing();

    renderStage();
  }

  requestAnimationFrame(tick);
}

// Looks for all four corner markers in the current frame and, if all are
// found, (re)solves the homography from their known screen positions and
// detected camera positions. If any are missing this frame (temporarily
// occluded, out of view, etc.), the previous homography is kept as-is.
function updateHomography(frame) {
  const arMarkers = arDetector.detect(frame);
  const correspondences = [];

  for (const marker of CORNER_MARKERS) {
    // hammingDistance is 0 only for an exact bit-for-bit match. A nonzero
    // distance means the read was corrupted (e.g. by glare) and the library
    // guessed the closest known code — which can be flat-out wrong, so
    // those are treated the same as not seeing the marker at all rather than
    // risking a bad point in the homography.
    const detected = arMarkers.find((m) => m.id === marker.id && m.hammingDistance === 0);
    marker.element.classList.toggle('detected', !!detected);

    if (detected) {
      correspondences.push({
        camera: averageOf(detected.corners),
        screen: elementCenter(marker.element),
      });
    }
  }

  if (correspondences.length < CORNER_MARKERS.length) {
    const seen = `${correspondences.length}/${CORNER_MARKERS.length} corners seen`;
    statusEl.textContent = homography ? `Tracking (last calibration, ${seen})` : `Calibrating… (${seen})`;
    return;
  }

  homography = computeHomography(correspondences);
  statusEl.textContent = 'Tracking';
}

function elementCenter(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function averageOf(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function renderStage() {
  stageCtx.clearRect(0, 0, stage.width, stage.height);

  if (!homography) {
    return;
  }

  for (const { data, location } of trackedTokens.values()) {
    const portalImage = PORTAL_IMAGES_BY_DATA[data];
    if (!portalImage) {
      continue;
    }

    const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = location;
    const center = applyHomography(homography, centerOf(location));
    const topLeft = applyHomography(homography, topLeftCorner);
    const topRight = applyHomography(homography, topRightCorner);
    const bottomLeft = applyHomography(homography, bottomLeftCorner);
    const bottomRight = applyHomography(homography, bottomRightCorner);

    const radius = Math.hypot(topLeft.x - center.x, topLeft.y - center.y) * 1.3 * 2;

    // "Up" in the code's own orientation (from its bottom edge toward its
    // top edge) rather than screen-space up, so the offset stays centered
    // over the code even when it's rotated rather than drifting sideways.
    const codeWidth = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
    const codeHeight = Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y);
    const upX = (topLeft.x - bottomLeft.x) / codeHeight;
    const upY = (topLeft.y - bottomLeft.y) / codeHeight;

    const topEdgeMidX = (topLeft.x + topRight.x) / 2;
    const topEdgeMidY = (topLeft.y + topRight.y) / 2;
    const offset = codeWidth * 0.5;
    const portalCenter = {
      x: topEdgeMidX + upX * offset,
      y: topEdgeMidY + upY * offset,
    };

    drawPortal(portalImage, portalCenter, radius);

    const name = CHARACTER_NAMES[data];
    if (name) {
      // Below the code's own bottom edge (opposite side from the portal,
      // which floats above its top edge), so the two don't overlap.
      const bottomEdgeMidX = (bottomLeft.x + bottomRight.x) / 2;
      const bottomEdgeMidY = (bottomLeft.y + bottomRight.y) / 2;
      const namePosition = {
        x: bottomEdgeMidX - upX * 24,
        y: bottomEdgeMidY - upY * 24,
      };
      drawCharacterName(name, namePosition);
    }
  }

  if (fingertip && performance.now() - fingertip.seenAt < POINT_GRACE_MS) {
    drawFingertip(fingertip);
  }
}

function drawCharacterName(name, position) {
  stageCtx.save();
  stageCtx.font = 'bold 22px monospace';
  stageCtx.textAlign = 'center';
  stageCtx.textBaseline = 'middle';
  stageCtx.lineWidth = 5;
  stageCtx.strokeStyle = '#000';
  stageCtx.strokeText(name, position.x, position.y);
  stageCtx.fillStyle = '#F5E2BA';
  stageCtx.fillText(name, position.x, position.y);
  stageCtx.restore();
}

// Sized bigger than the code itself so it shows through around its edges,
// rather than a hard-edged shape.
function drawPortal(image, center, radius) {
  if (!image.complete) {
    return;
  }

  const size = radius * 2;
  stageCtx.drawImage(image, center.x - radius, center.y - radius, size, size);
}

// Solves for a homography (a 3x3 projective transform, with h33 fixed to 1)
// that maps each point's `camera` coordinates onto its `screen` coordinates,
// given the four corner-marker correspondences for this frame.
function computeHomography(points) {
  const A = [];
  const b = [];

  for (const { camera, screen } of points) {
    const { x, y } = camera;
    A.push([x, y, 1, 0, 0, 0, -x * screen.x, -y * screen.x]);
    b.push(screen.x);
    A.push([0, 0, 0, x, y, 1, -x * screen.y, -y * screen.y]);
    b.push(screen.y);
  }

  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(A, b);
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function applyHomography(h, point) {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = h;
  const w = h31 * point.x + h32 * point.y + h33;
  return {
    x: (h11 * point.x + h12 * point.y + h13) / w,
    y: (h21 * point.x + h22 * point.y + h23) / w,
  };
}

// Solves the linear system A * x = b via Gaussian elimination with partial
// pivoting.
function solveLinearSystem(A, b) {
  const n = A.length;
  const rows = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivotRow][col])) {
        pivotRow = row;
      }
    }
    [rows[col], rows[pivotRow]] = [rows[pivotRow], rows[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = rows[row][col] / rows[col][col];
      for (let c = col; c <= n; c += 1) {
        rows[row][c] -= factor * rows[col][c];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = rows[row][n];
    for (let col = row + 1; col < n; col += 1) {
      sum -= rows[row][col] * x[col];
    }
    x[row] = sum / rows[row][row];
  }

  return x;
}

// Decodes every QR code in the current frame in one call (zxing-wasm scans
// the whole image natively, unlike jsQR which only ever returns a single
// symbol per call and previously had to be run across a manual grid of
// overlapping crops to find more than one code). Async and fire-and-forget;
// see the detectionInFlight note above.
const ZXING_READ_OPTIONS = { formats: ['QRCode'], tryHarder: false, maxNumberOfSymbols: 10 };

async function scanForQRCodes() {
  if (detectionInFlight) {
    return;
  }
  detectionInFlight = true;

  try {
    detectionCtx.drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);
    const frame = detectionCtx.getImageData(0, 0, detectionCanvas.width, detectionCanvas.height);
    const results = await ZXingWASM.readBarcodes(frame, ZXING_READ_OPTIONS);

    latestDetections = results.map(scaleUpToFullRes);
    recordScanResult(latestDetections.length > 0);
    updateTrackedTokens(latestDetections);
    updateCharacterLands();
  } catch (error) {
    console.error('QR decode failed:', error);
  } finally {
    detectionInFlight = false;
  }
}

// Converts a zxing-wasm result (text + 4-corner position, in
// detection-canvas pixel space) into this app's internal detection shape,
// scaled up to full-resolution camera-space coordinates so positions line
// up with the homography, which is built from full-resolution corner
// detections.
function scaleUpToFullRes(result) {
  const scale = (point) => ({ x: point.x / detectionScale, y: point.y / detectionScale });
  const { topLeft, topRight, bottomRight, bottomLeft } = result.position;

  return {
    data: result.text,
    location: {
      topLeftCorner: scale(topLeft),
      topRightCorner: scale(topRight),
      bottomRightCorner: scale(bottomRight),
      bottomLeftCorner: scale(bottomLeft),
    },
  };
}

function centerOf(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  return {
    x: (topLeftCorner.x + bottomRightCorner.x) / 2,
    y: (topLeftCorner.y + bottomRightCorner.y) / 2,
  };
}

// ---------------------------------------------------------------------------
// Hand pointing: pointing at a land with an index finger announces who is in
// it, e.g. "JuJu is doing great", "no one is doing great", "JuJu and 雨轩 are
// doing great".
// ---------------------------------------------------------------------------

const MEDIAPIPE_VERSION = '1.1.0';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Hand detection is comparatively expensive, so it runs a few times a
// second rather than on every frame.
const HAND_DETECT_INTERVAL_MS = 80;
// The fingertip has to stay on one land this long before it counts as
// pointing at it, so a hand sweeping across the display doesn't announce
// every land it passes over. A brief dropout (a missed frame) doesn't reset
// the timer.
const POINT_HOLD_MS = 700;
const POINT_GRACE_MS = 350;
const POINT_ANSWER_DISPLAY_MS = 6000;

const handStatusEl = document.getElementById('handStatus');
const pointingAnswerEl = document.getElementById('pointingAnswer');

let handLandmarker = null;
let lastHandDetectAt = 0;
let fingertip = null;
let pointState = null;
let pointingAnswerTimer = null;

// MediaPipe hand landmark indices: the wrist is 0, and each finger is
// [knuckle, middle joint (pip), tip].
const INDEX_FINGER = [5, 6, 8];
const OTHER_FINGERS = [[9, 10, 12], [13, 14, 16], [17, 18, 20]];
const INDEX_TIP = 8;

// A finger counts as extended when its tip is clearly farther from the wrist
// than its middle joint is, and curled when the tip has folded back closer.
// Comparing distances from the wrist (rather than looking at up/down) makes
// this work however the hand is rotated, e.g. seen from above.
const EXTENDED_RATIO = 1.1;
const CURLED_RATIO = 0.9;

function fingerReach(points, finger) {
  const [, pip, tip] = finger;
  const wrist = points[0];
  const dist = (i) => Math.hypot(points[i].x - wrist.x, points[i].y - wrist.y);
  return dist(tip) / dist(pip);
}

// `points` are the 21 hand landmarks in pixel space. Pointing means the
// index finger is out while the middle finger is folded away and at least
// one of the ring/pinky is too (which rules out an open hand, a peace sign
// and a raised middle finger).
function isPointingGesture(points) {
  if (fingerReach(points, INDEX_FINGER) < EXTENDED_RATIO) {
    return false;
  }

  const [middle, ...ringAndPinky] = OTHER_FINGERS.map((finger) => fingerReach(points, finger));
  return middle < CURLED_RATIO && ringAndPinky.some((reach) => reach < CURLED_RATIO);
}

// Characters currently in `land` (remembered there and still on screen), in
// CHARACTER_NAMES order.
function namesInLand(land) {
  const now = performance.now();
  return Object.keys(CHARACTER_NAMES)
    .filter((data) => characterLands.get(data) === land && isOnScreen(data, now))
    .map((data) => CHARACTER_NAMES[data]);
}

// The answer to "who is in this land?" as separate parts, so it can be shown
// as text and spoken with each part in the right voice (see speakParts).
function whoIsInParts(land) {
  const names = namesInLand(land);
  if (names.length === 0) {
    return ['no one', 'is', land];
  }

  const parts = [];
  names.forEach((name, i) => {
    if (i > 0) {
      parts.push('and');
    }
    parts.push(name);
  });
  parts.push(names.length === 1 ? 'is' : 'are', land);
  return parts;
}

function announceWhoIsIn(land) {
  const parts = whoIsInParts(land);

  pointingAnswerEl.textContent = parts.join(' ');
  clearTimeout(pointingAnswerTimer);
  pointingAnswerTimer = setTimeout(() => {
    pointingAnswerEl.textContent = '';
  }, POINT_ANSWER_DISPLAY_MS);

  speakParts(parts);
}

// Tracks which land is being pointed at and announces it once the fingertip
// has rested there for POINT_HOLD_MS. Pointing at a land again (after
// moving away from it, or to another land) announces again.
function updatePointState(land, now) {
  if (land) {
    if (!pointState || pointState.land !== land) {
      pointState = { land, since: now, lastSeen: now, announced: false };
    } else {
      pointState.lastSeen = now;
    }

    if (!pointState.announced && now - pointState.since >= POINT_HOLD_MS) {
      pointState.announced = true;
      announceWhoIsIn(land);
    }
  } else if (pointState && now - pointState.lastSeen > POINT_GRACE_MS) {
    pointState = null;
  }

  const active = pointState ? pointState.land : null;
  for (const l of LANDS) {
    l.element.classList.toggle('pointed', l.name === active);
  }
}

function detectPointing() {
  if (!handLandmarker || !homography) {
    return;
  }

  const now = performance.now();
  if (now - lastHandDetectAt < HAND_DETECT_INTERVAL_MS) {
    return;
  }
  lastHandDetectAt = now;

  try {
    const landmarks = handLandmarker.detectForVideo(video, now).landmarks[0];
    let tip = null;
    let status = 'none';

    if (landmarks) {
      // Landmarks are normalized to the frame; scale to the same full-
      // resolution camera space the homography was built in.
      const points = landmarks.map((p) => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }));
      status = 'seen (not pointing)';

      if (isPointingGesture(points)) {
        tip = applyHomography(homography, points[INDEX_TIP]);
        fingertip = { ...tip, seenAt: now };
      }
    }

    const land = tip ? landContaining(tip) : null;
    updatePointState(land, now);

    if (tip) {
      status = `pointing at ${land || 'no land'}`;
    }
    handStatusEl.textContent = `Hand: ${status}`;
  } catch (error) {
    console.error('Hand detection failed:', error);
    handStatusEl.textContent = 'Hand: unavailable';
    handLandmarker = null;
  }
}

function drawFingertip(point) {
  stageCtx.save();
  stageCtx.beginPath();
  stageCtx.arc(point.x, point.y, 14, 0, Math.PI * 2);
  stageCtx.fillStyle = '#F5E2BA';
  stageCtx.fill();
  stageCtx.lineWidth = 4;
  stageCtx.strokeStyle = '#000';
  stageCtx.stroke();
  stageCtx.restore();
}

// MediaPipe is loaded on demand (it's an ES module, and not needed until a
// hand is in view). Failing to load it must never affect the camera or
// token tracking, so any error is just reported in the status line.
async function initHandLandmarker() {
  handStatusEl.textContent = 'Hand: loading…';

  const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
  const { FilesetResolver, HandLandmarker } = await import(`${base}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);

  const create = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
  });

  try {
    handLandmarker = await create('GPU');
  } catch (gpuError) {
    handLandmarker = await create('CPU');
  }
  handStatusEl.textContent = 'Hand: ready';
}

initHandLandmarker().catch((error) => {
  console.error('Hand detection unavailable:', error);
  handStatusEl.textContent = 'Hand: unavailable';
});
