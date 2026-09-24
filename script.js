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

let sampleCanvas;
let sampleCtx;
let tickLoopStarted = false;
let latestDetections = [];

// Token QR scanning runs on a downscaled copy of the frame rather than the
// full capture resolution, since jsQR's cost scales with total pixels
// examined. This lets us afford full tile overlap (see TILE_STEP below)
// for reliability while still being faster overall than scanning the full
// resolution without overlap. Corner-marker (ArUco) detection is unrelated
// and still runs on the full-resolution frame, unchanged.
const DETECTION_MAX_WIDTH = 1280;
let detectionCanvas;
let detectionCtx;
let detectionScale = 1;

// Rolling once-a-second readout of how often jsQR actually decodes
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

// jsQR data is matched exactly, so incidental whitespace or casing from
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
    trackedTokens.set(data, { data, location: detection.location, lastSeen: now });
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

// Approximate size of a QR code in the captured frame, in pixels, at a
// 1920-wide capture. Scaled down to match the actual detection resolution
// once it's known (see loadedmetadata below).
const QR_SIZE_AT_FULL_RES = 150;
// jsQR only ever returns one decoded symbol per call, so to find multiple
// codes in a frame we scan overlapping crop windows across the image and
// decode each one separately. The window is bigger than a code (with room
// for its quiet zone) and the step is small enough that the overlap between
// adjacent windows is at least one code-width, so no code can fall entirely
// across a window boundary and get missed.
let QR_SIZE;
let TILE_SIZE;
let TILE_STEP;

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

  QR_SIZE = Math.round(QR_SIZE_AT_FULL_RES * detectionScale);
  TILE_SIZE = QR_SIZE * 2;
  TILE_STEP = QR_SIZE;

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

    detectionCtx.drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);
    latestDetections = scanForQRCodes();
    recordScanResult(latestDetections.length > 0);
    updateTrackedTokens(latestDetections);

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

    const { topLeftCorner, topRightCorner, bottomLeftCorner } = location;
    const center = applyHomography(homography, centerOf(location));
    const topLeft = applyHomography(homography, topLeftCorner);
    const topRight = applyHomography(homography, topRightCorner);
    const bottomLeft = applyHomography(homography, bottomLeftCorner);

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
  }
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

function scanForQRCodes() {
  const xs = getTilePositions(detectionCanvas.width);
  const ys = getTilePositions(detectionCanvas.height);
  const detections = [];

  for (const y of ys) {
    for (const x of xs) {
      const tile = detectionCtx.getImageData(x, y, TILE_SIZE, TILE_SIZE);
      const qrCode = jsQR(tile.data, TILE_SIZE, TILE_SIZE);
      if (qrCode) {
        detections.push(offsetQRCode(qrCode, x, y));
      }
    }
  }

  // Dedupe in detection-canvas space (matching QR_SIZE's own scale), then
  // convert to full-resolution camera-space coordinates so positions line
  // up with the homography, which is built from full-resolution corner
  // detections.
  return dedupeDetections(detections).map(scaleUpToFullRes);
}

function scaleUpToFullRes(qrCode) {
  const scale = (point) => ({ x: point.x / detectionScale, y: point.y / detectionScale });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;

  return {
    data: qrCode.data,
    location: {
      topLeftCorner: scale(topLeftCorner),
      topRightCorner: scale(topRightCorner),
      bottomRightCorner: scale(bottomRightCorner),
      bottomLeftCorner: scale(bottomLeftCorner),
    },
  };
}

// Start offsets for tiles of TILE_SIZE covering `dimension`, stepping by
// TILE_STEP and with a final tile flush against the far edge so the whole
// frame is covered even when it doesn't divide evenly by the step.
function getTilePositions(dimension) {
  if (dimension <= TILE_SIZE) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + TILE_SIZE <= dimension; pos += TILE_STEP) {
    positions.push(pos);
  }

  const lastPosition = dimension - TILE_SIZE;
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return positions;
}

function offsetQRCode(qrCode, offsetX, offsetY) {
  const shift = (point) => ({ x: point.x + offsetX, y: point.y + offsetY });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;

  return {
    data: qrCode.data,
    location: {
      topLeftCorner: shift(topLeftCorner),
      topRightCorner: shift(topRightCorner),
      bottomRightCorner: shift(bottomRightCorner),
      bottomLeftCorner: shift(bottomLeftCorner),
    },
  };
}

// The same QR code is often found in more than one overlapping tile, so
// collapse detections whose bounding boxes are centered near each other.
function dedupeDetections(detections) {
  const unique = [];

  for (const detection of detections) {
    const center = centerOf(detection.location);
    const isDuplicate = unique.some((existing) => {
      const existingCenter = centerOf(existing.location);
      const dx = center.x - existingCenter.x;
      const dy = center.y - existingCenter.y;
      return Math.sqrt(dx * dx + dy * dy) < QR_SIZE;
    });

    if (!isDuplicate) {
      unique.push(detection);
    }
  }

  return unique;
}

function centerOf(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  return {
    x: (topLeftCorner.x + bottomRightCorner.x) / 2,
    y: (topLeftCorner.y + bottomRightCorner.y) / 2,
  };
}
