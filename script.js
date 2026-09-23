const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

let sampleCanvas;
let sampleCtx;

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

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

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  requestAnimationFrame(tick);
});

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    for (const qrCode of scanForQRCodes()) {
      drawHalo(qrCode.location);
    }
  }

  requestAnimationFrame(tick);
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

function drawHalo(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  const center = centerOf(location);
  const radius = Math.hypot(
    bottomRightCorner.x - topLeftCorner.x,
    bottomRightCorner.y - topLeftCorner.y,
  ) / 2;

  overlayCtx.save();
  overlayCtx.shadowColor = '#ffee00';
  overlayCtx.shadowBlur = radius * 0.6;
  overlayCtx.strokeStyle = '#ffee00';
  overlayCtx.lineWidth = Math.max(6, radius * 0.15);
  overlayCtx.beginPath();
  overlayCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  overlayCtx.stroke();
  overlayCtx.restore();
}
