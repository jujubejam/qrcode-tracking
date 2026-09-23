const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const cameraSelect = document.getElementById('cameraSelect');
const stage = document.getElementById('stage');
const stageCtx = stage.getContext('2d');
const calibrateButton = document.getElementById('calibrateButton');
const calibrationPanel = document.getElementById('calibration');
const calibrationInstruction = document.getElementById('calibrationInstruction');
const captureCalibrationPointButton = document.getElementById('captureCalibrationPoint');

let sampleCanvas;
let sampleCtx;
let currentStream;
let tickLoopStarted = false;
let latestDetections = [];

// Maps a point in the camera's pixel space onto the screen's pixel space, so
// a code's position as seen from above corresponds to where it physically
// sits on the display. Set once calibration finishes; see calibrate().
let homography = null;
let calibrating = false;
let calibrationStep = 0;
let calibrationPoints = [];

const CALIBRATION_TARGET_LABELS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const CALIBRATION_MARGIN = 60;

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

// The four corners of the screen, in screen pixel space, that the user is
// asked to place a code on top of in turn during calibration.
function calibrationTargets() {
  return [
    { x: CALIBRATION_MARGIN, y: CALIBRATION_MARGIN },
    { x: stage.width - CALIBRATION_MARGIN, y: CALIBRATION_MARGIN },
    { x: stage.width - CALIBRATION_MARGIN, y: stage.height - CALIBRATION_MARGIN },
    { x: CALIBRATION_MARGIN, y: stage.height - CALIBRATION_MARGIN },
  ];
}

function startCalibration() {
  calibrating = true;
  calibrationStep = 0;
  calibrationPoints = [];
  stage.classList.remove('opaque');
  calibrationPanel.hidden = false;
  showCalibrationStep();
}

function showCalibrationStep() {
  const label = CALIBRATION_TARGET_LABELS[calibrationStep];
  calibrationInstruction.textContent = `Place a QR code at the ${label} marker, then press Capture.`;
}

function captureCalibrationPoint() {
  if (latestDetections.length === 0) {
    calibrationInstruction.textContent = 'No QR code seen — place one on the marker and try again.';
    return;
  }

  calibrationPoints.push({
    camera: centerOf(latestDetections[0].location),
    screen: calibrationTargets()[calibrationStep],
  });

  calibrationStep += 1;
  if (calibrationStep < CALIBRATION_TARGET_LABELS.length) {
    showCalibrationStep();
    return;
  }

  homography = computeHomography(calibrationPoints);
  calibrating = false;
  calibrationPanel.hidden = true;
  stage.classList.add('opaque');
}

calibrateButton.addEventListener('click', startCalibration);
captureCalibrationPointButton.addEventListener('click', captureCalibrationPoint);

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
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

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
    latestDetections = scanForQRCodes();

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    for (const qrCode of latestDetections) {
      drawBox(qrCode.location);
      drawLabel(qrCode.location, qrCode.data);
    }

    renderStage();
  }

  requestAnimationFrame(tick);
}

function renderStage() {
  stageCtx.clearRect(0, 0, stage.width, stage.height);

  if (calibrating) {
    drawCalibrationTarget();
    return;
  }

  if (!homography) {
    return;
  }

  for (const qrCode of latestDetections) {
    drawHalo(applyHomography(homography, centerOf(qrCode.location)));
  }
}

function drawCalibrationTarget() {
  const { x, y } = calibrationTargets()[calibrationStep];

  stageCtx.strokeStyle = '#ffee00';
  stageCtx.lineWidth = 3;
  stageCtx.beginPath();
  stageCtx.moveTo(x - 20, y);
  stageCtx.lineTo(x + 20, y);
  stageCtx.moveTo(x, y - 20);
  stageCtx.lineTo(x, y + 20);
  stageCtx.arc(x, y, 12, 0, Math.PI * 2);
  stageCtx.stroke();
}

function drawHalo(point) {
  stageCtx.save();
  stageCtx.shadowColor = '#ffee00';
  stageCtx.shadowBlur = 30;
  stageCtx.strokeStyle = '#ffee00';
  stageCtx.lineWidth = 8;
  stageCtx.beginPath();
  stageCtx.arc(point.x, point.y, 40, 0, Math.PI * 2);
  stageCtx.stroke();
  stageCtx.restore();
}

// Solves for a homography (a 3x3 projective transform, with h33 fixed to 1)
// that maps each point's `camera` coordinates onto its `screen` coordinates,
// given the four correspondences gathered during calibration.
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

function drawBox(location) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = '#00ff00';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}
