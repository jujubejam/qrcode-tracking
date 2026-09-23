const video = document.getElementById('webcam');
const stage = document.getElementById('stage');
const stageCtx = stage.getContext('2d');
const statusEl = document.getElementById('status');

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

// A code missing from one frame's scan (motion blur, a brief bad decode,
// etc.) shouldn't make its portal flicker off. Each detected code's last
// known location is kept for a short grace period after it stops being
// seen, and only dropped once that expires.
const TOKEN_PERSISTENCE_MS = 300;
const trackedTokens = new Map();

function updateTrackedTokens(detections) {
  const now = performance.now();

  for (const detection of detections) {
    trackedTokens.set(detection.data, { data: detection.data, location: detection.location, lastSeen: now });
  }

  for (const [data, token] of trackedTokens) {
    if (now - token.lastSeen > TOKEN_PERSISTENCE_MS) {
      trackedTokens.delete(data);
    }
  }
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

navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
})
  .then((stream) => {
    video.srcObject = stream;
  })
  .catch((error) => {
    console.error('Unable to access camera:', error);
  });

function resizeStage() {
  stage.width = window.innerWidth;
  stage.height = window.innerHeight;
}

window.addEventListener('resize', resizeStage);
resizeStage();

// Approximate size of a QR code in the captured frame, in pixels.
const QR_SIZE = 150;
// jsQR only ever returns one decoded symbol per call, so to find multiple
// codes in a frame we scan overlapping crop windows across the image and
// decode each one separately. The window is bigger than a code (with room
// for its quiet zone) and the step is small enough that the overlap between
// adjacent windows is at least one code-width, so no code can fall entirely
// across a window boundary and get missed.
const TILE_SIZE = QR_SIZE * 2;
const TILE_STEP = QR_SIZE;

video.addEventListener('loadedmetadata', () => {
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

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
    latestDetections = scanForQRCodes();
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
  const xs = getTilePositions(sampleCanvas.width);
  const ys = getTilePositions(sampleCanvas.height);
  const detections = [];

  for (const y of ys) {
    for (const x of xs) {
      const tile = sampleCtx.getImageData(x, y, TILE_SIZE, TILE_SIZE);
      const qrCode = jsQR(tile.data, TILE_SIZE, TILE_SIZE);
      if (qrCode) {
        detections.push(offsetQRCode(qrCode, x, y));
      }
    }
  }

  return dedupeDetections(detections);
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
